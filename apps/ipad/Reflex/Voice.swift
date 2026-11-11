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
        guard await Self.allowed() else {
            throw VoiceError("Reflex needs the microphone and speech recognition. Allow them in Settings.")
        }
        guard let recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US")),
              recognizer.isAvailable else {
            throw VoiceError("Speech recognition isn't available right now.")
        }
        guard recognizer.supportsOnDeviceRecognition else {
            throw VoiceError("On-device speech recognition isn't available on this iPad for \(recognizer.locale.identifier).")
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
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [request] buffer, _ in
            request.append(buffer)
        }
        engine.prepare()
        try engine.start()
        started = Date()
        state = .listening
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            let transcription = result?.bestTranscription
            let final = result?.isFinal ?? false
            let failed = error != nil
            Task { @MainActor in
                guard let self else { return }
                if let transcription {
                    self.latest = transcription
                    self.partial = transcription.formattedString
                }
                if final || failed { self.finish() }
            }
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
            var w: [String: Any] = [
                "text": s.substring,
                "start": Int(((base + s.timestamp) * 1000).rounded()),
                "end": Int(((base + s.timestamp + s.duration) * 1000).rounded()),
            ]
            if s.confidence > 0 { w["confidence"] = (Double(s.confidence) * 100).rounded() / 100 }
            return w
        }
        log.info("Heard \(t?.formattedString ?? "", privacy: .public) (\(words.count) words)")
        return (t?.formattedString ?? "", words)
    }

    private func finish() {
        finished?.resume()
        finished = nil
    }

    private static func allowed() async -> Bool {
        let speech = await withCheckedContinuation { c in
            SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0 == .authorized) }
        }
        guard speech else { return false }
        return await AVAudioApplication.requestRecordPermission()
    }
}

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
