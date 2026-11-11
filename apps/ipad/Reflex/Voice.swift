import AVFoundation
import OSLog
import Speech
import SwiftUI

private let log = Logger(subsystem: "si.eilmer.reflex", category: "voice")

/// Hold-to-talk speech, transcribed on this iPad with Apple's on-device
/// recognition (SPEC §10). Audio never leaves the iPad; only the transcript and
/// its word timings go into the Send.
@MainActor @Observable
final class VoiceCapture {
    enum State: Equatable {
        case idle
        case listening
        case finishing
    }

    private(set) var state: State = .idle
    /// What it has heard so far, while listening.
    private(set) var partial = ""

    @ObservationIgnored private let engine = AVAudioEngine()
    @ObservationIgnored private var request: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored private var task: SFSpeechRecognitionTask?
    @ObservationIgnored private var started = Date()
    @ObservationIgnored private var latest: SFTranscription?
    @ObservationIgnored private var finished: CheckedContinuation<Void, Never>?

    /// Starts listening. Throws a message the person can read if it can't.
    func start() async throws {
        guard state == .idle else { return }
        let recognizer = try Self.recognizer()
        guard await Self.allowed() else {
            throw VoiceError("Reflex needs the microphone and speech recognition. Allow them in Settings.")
        }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: .duckOthers)
        try session.setActive(true, options: .notifyOthersOnDeactivation)

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        self.request = request
        latest = nil
        partial = ""

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        Self.tap(input, format: format, into: request)
        engine.prepare()
        try engine.start()
        started = Date()
        state = .listening
        task = Self.listen(recognizer, request) { [weak self] heard, done in
            guard let self else { return }
            if let heard {
                self.latest = heard
                self.partial = heard.formattedString
            }
            if done { self.finish() }
        }
        log.info("Listening, on-device")
    }

    /// Stops listening and returns the transcript with each word's timing, in
    /// milliseconds since 1970 (the clock strokes use).
    func stop() async -> (said: String, words: [[String: Any]]) {
        guard state == .listening else { return ("", []) }
        state = .finishing
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        // The final result follows endAudio; don't wait on it forever.
        await withCheckedContinuation { c in
            finished = c
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(2.5))
                self.finish()
            }
        }
        task?.cancel()
        task = nil
        request = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        state = .idle
        let t = latest
        partial = ""
        let base = started.timeIntervalSince1970
        let words: [[String: Any]] = (t?.segments ?? []).map { s in
            ["text": s.substring,
             "start_ms": Int(((base + s.timestamp) * 1000).rounded()),
             "end_ms": Int(((base + s.timestamp + s.duration) * 1000).rounded())]
        }
        log.info("Heard \(t?.formattedString ?? "", privacy: .public) (\(words.count) words)")
        return (t?.formattedString ?? "", words)
    }

    /// The on-device recognizer for the person's language. Audio never goes to a server, so
    /// without on-device recognition there is no voice.
    private nonisolated static func recognizer() throws -> SFSpeechRecognizer {
        guard let r = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US")), r.isAvailable else {
            throw VoiceError("Speech recognition isn't available right now.")
        }
        guard r.supportsOnDeviceRecognition else {
            throw VoiceError("On-device speech recognition isn't available on this iPad for \(r.locale.identifier).")
        }
        return r
    }

    #if DEBUG
    /// Transcribes an audio file through the same on-device path as the mic, for
    /// the Simulator (`reflex://debug/voice?file=`): its timings start when the file does.
    func debugTranscribe(_ url: URL) async throws -> (said: String, words: [[String: Any]]) {
        _ = try Self.recognizer()
        guard await Self.speechAllowed() else { throw VoiceError("Speech recognition isn't allowed.") }
        let started = Date()
        let heard = try await Self.transcribe(url)
        let base = started.timeIntervalSince1970
        let words: [[String: Any]] = heard.segments.map { s in
            ["text": s.text, "start_ms": Int(((base + s.at) * 1000).rounded()), "end_ms": Int(((base + s.at + s.duration) * 1000).rounded())]
        }
        log.info("Heard from file: \(heard.text, privacy: .public) (\(words.count) words)")
        return (heard.text, words)
    }

    private nonisolated static func transcribe(_ url: URL) async throws -> (text: String, segments: [Heard]) {
        let recognizer = try recognizer()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.addsPunctuation = true
        let file = try AVAudioFile(forReading: url)
        return try await withCheckedThrowingContinuation { c in
            let once = Once()
            let task = recognizer.recognitionTask(with: request) { result, error in
                guard result?.isFinal == true || error != nil, once.first() else { return }
                let t = result?.bestTranscription
                if let error, t == nil {
                    c.resume(throwing: VoiceError("Speech recognition failed: \(error.localizedDescription)"))
                    return
                }
                c.resume(returning: (t?.formattedString ?? "", (t?.segments ?? []).map { Heard(text: $0.substring, at: $0.timestamp, duration: $0.duration) }))
            }
            _ = task
            while let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 4096),
                  (try? file.read(into: buffer)) != nil, buffer.frameLength > 0 {
                request.append(buffer)
            }
            request.endAudio()
        }
    }
    #endif

    // The audio tap and the recognizer call back on their own queues, so their
    // closures are made here, outside the main actor, and hop back to it.
    private nonisolated static func tap(_ input: AVAudioInputNode, format: AVAudioFormat, into request: SFSpeechAudioBufferRecognitionRequest) {
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }
    }

    private nonisolated static func listen(
        _ recognizer: SFSpeechRecognizer,
        _ request: SFSpeechAudioBufferRecognitionRequest,
        update: @escaping @MainActor @Sendable (SFTranscription?, Bool) -> Void
    ) -> SFSpeechRecognitionTask {
        recognizer.recognitionTask(with: request) { result, error in
            nonisolated(unsafe) let heard = result?.bestTranscription
            let done = result?.isFinal ?? false || error != nil
            Task { @MainActor in update(heard, done) }
        }
    }

    private func finish() {
        finished?.resume()
        finished = nil
    }

    private nonisolated static func allowed() async -> Bool {
        guard await speechAllowed() else { return false }
        return await AVAudioApplication.requestRecordPermission()
    }

    private nonisolated static func speechAllowed() async -> Bool {
        await withCheckedContinuation { c in
            SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0 == .authorized) }
        }
    }
}

#if DEBUG
/// True the first time only; the recognizer can report more than once.
private final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func first() -> Bool { lock.withLock { defer { done = true }; return !done } }
}

struct Heard: Sendable {
    var text: String
    var at: TimeInterval
    var duration: TimeInterval
}
#endif

struct VoiceError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

/// The mic button: hold it and talk; let go and the voice goes out with the Ink.
struct MicButton: View {
    let voice: VoiceCapture
    let onFail: (String) -> Void
    let onRelease: (_ said: String, _ words: [[String: Any]]) -> Void
    @State private var holding = false
    @State private var starting: Task<Bool, Never>?

    var body: some View {
        let listening = voice.state == .listening
        Image(systemName: listening ? "waveform" : "mic.fill")
            .font(.system(size: 20, weight: .semibold))
            .symbolEffect(.variableColor.iterative, isActive: listening)
            .foregroundStyle(listening ? Color.white : Color.accentColor)
            .frame(width: 56, height: 56)
            .background(listening ? Color.red : Color.clear, in: Circle())
            .glassEffect(.regular.interactive(), in: Circle())
            .scaleEffect(holding ? 1.12 : 1)
            .animation(.spring(duration: 0.2), value: holding)
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in
                        guard !holding else { return }
                        holding = true
                        starting = Task {
                            do {
                                try await voice.start()
                                return true
                            } catch {
                                onFail(error.localizedDescription)
                                return false
                            }
                        }
                    }
                    .onEnded { _ in
                        guard holding else { return }
                        holding = false
                        let start = starting
                        Task {
                            // A short press can end before listening has started.
                            guard await start?.value == true else { return }
                            let (said, words) = await voice.stop()
                            onRelease(said, words)
                        }
                    }
            )
            .accessibilityIdentifier("mic-button")
            .accessibilityLabel("Hold to talk")
    }
}
