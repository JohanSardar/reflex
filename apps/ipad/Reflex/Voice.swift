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
    /// The input level while listening, 0…1, for the meter.
    private(set) var level: Float = 0
    /// The person is holding the button (shown at once, before the mic is ready).
    var holding = false

    @ObservationIgnored private let engine = AVAudioEngine()
    @ObservationIgnored private var request: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored private var task: SFSpeechRecognitionTask?
    @ObservationIgnored private var started = Date()
    @ObservationIgnored private var latest: SFTranscription?
    @ObservationIgnored private var finished: CheckedContinuation<Void, Never>?

    /// True when the mic or speech recognition hasn't been allowed yet (or was refused).
    static var needsPermission: Bool {
        SFSpeechRecognizer.authorizationStatus() != .authorized || AVAudioApplication.shared.recordPermission != .granted
    }

    /// Asks for the mic and speech recognition, outside a hold. True if both are allowed.
    func requestPermission() async -> Bool { await Self.allowed() }

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
        Self.tap(input, format: format, into: request) { [weak self] l in self?.level = l }
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
        level = 0
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
    private nonisolated static func tap(_ input: AVAudioInputNode, format: AVAudioFormat, into request: SFSpeechAudioBufferRecognitionRequest,
                                        level: @escaping @MainActor @Sendable (Float) -> Void) {
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
            guard let data = buffer.floatChannelData?[0] else { return }
            let n = Int(buffer.frameLength)
            var sum: Float = 0
            for i in 0 ..< n { sum += data[i] * data[i] }
            let rms = sqrt(sum / Float(max(n, 1)))
            let l = min(1, max(0, (20 * log10(max(rms, 0.000_01)) + 50) / 45))
            Task { @MainActor in level(l) }
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

/// The mic and Send, one glass group in the bottom-right corner. Hold the mic and talk;
/// let go and the voice goes out with the ink. Send shows Sends still waiting for the Mac.
struct VoiceSendDock: View {
    let voice: VoiceCapture
    let pending: Int
    let lastSend: Date?
    var preparing = false
    /// Not paired yet: Send still works (it says how to pair) but looks quieter.
    var paired = true
    let onFail: (String) -> Void
    let onRelease: (_ said: String, _ words: [[String: Any]]) -> Void
    let send: () -> Void
    @State private var starting: Task<Bool, Never>?
    @State private var started = Date()
    @State private var sentPulse = false
    @State private var permissionTouch = false
    @State private var pressed = false

    var body: some View {
        let live = voice.holding || voice.state != .idle
        GlassEffectContainer(spacing: 10) {
            HStack(spacing: 10) {
                micControl(live: live)
                if !live { sendButton.transition(.scale.combined(with: .opacity)) }
            }
        }
        .animation(.spring(duration: 0.35, bounce: 0.25), value: live)
        .onChange(of: lastSend) { _, _ in
            sentPulse = true
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            Task { try? await Task.sleep(for: .seconds(1.4)); sentPulse = false }
        }
    }

    private func micControl(live: Bool) -> some View {
        HStack(spacing: 12) {
            Image(systemName: live ? "mic.fill" : "mic")
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(live ? Color.white : .primary)
                .symbolEffect(.pulse, isActive: live)
            if live {
                LevelMeter(level: voice.level, active: voice.state == .listening)
                    .frame(width: 120, height: 26)
                TimelineView(.periodic(from: started, by: 1)) { ctx in
                    Text(Duration.seconds(max(0, ctx.date.timeIntervalSince(started))).formatted(.time(pattern: .minuteSecond)))
                        .font(.system(size: 15, weight: .semibold)).monospacedDigit().foregroundStyle(.white)
                }
                Text("Release to Send").font(.system(size: 14, weight: .medium)).foregroundStyle(.white.opacity(0.85))
            }
        }
        .padding(.horizontal, live ? 20 : 0)
        .frame(minWidth: 56, minHeight: 56)
        // Opaque backing under the glass, so the disc reads as a control on dark paper too.
        .background(live ? Color.clear : Color(.tertiarySystemBackground).opacity(0.9), in: Capsule())
        .glassEffect(live ? .regular.tint(.red) : .regular, in: Capsule())
        .scaleEffect(pressed && !live ? 0.94 : 1)
        .animation(.spring(duration: 0.2), value: pressed)
        // The touch is tracked by UIKit on a view that stays put while the button changes shape:
        // a SwiftUI gesture is lost when the view is rebuilt mid-touch, and then release never ends it.
        .overlay {
            PressTracker { down in
                if down { pressBegan() } else { pressEnded() }
            }
        }
        .accessibilityElement()
        .accessibilityIdentifier("mic-button")
        .accessibilityLabel(live ? "Listening. Release to send." : "Hold to talk")
        .accessibilityAddTraits(.isButton)
    }

    private func pressBegan() {
        log.info("Mic press began (holding \(voice.holding))")
        pressed = true
        guard !voice.holding, !permissionTouch else { return }
        // The first time, only ask. A permission alert must never turn into a Send.
        if VoiceCapture.needsPermission {
            permissionTouch = true
            Task {
                let ok = await voice.requestPermission()
                onFail(ok ? "Ready. Hold the mic and talk, then let go to Send." : "Reflex needs the microphone and speech recognition. Allow them in Settings.")
            }
            return
        }
        voice.holding = true
        started = Date()
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        starting = Task {
            do {
                try await voice.start()
                return true
            } catch {
                voice.holding = false
                onFail(error.localizedDescription)
                return false
            }
        }
    }

    /// Release, or a touch the system cancelled (an alert, a palm): either way recording ends.
    private func pressEnded() {
        log.info("Mic press ended (holding \(voice.holding), state \(String(describing: voice.state), privacy: .public))")
        pressed = false
        if permissionTouch { permissionTouch = false; return }
        guard voice.holding else { return }
        voice.holding = false
        let start = starting
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        Task {
            // A short press can end before listening has started.
            guard await start?.value == true else {
                _ = await voice.stop()
                return
            }
            let (said, words) = await voice.stop()
            // Nothing heard: no Send.
            guard !said.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                onFail("Didn't catch that. Hold the mic and talk, then let go.")
                return
            }
            onRelease(said, words)
        }
    }

    private var sendButton: some View {
        Button(action: send) {
            HStack(spacing: 8) {
                Image(systemName: sentPulse ? "checkmark" : "paperplane.fill")
                    .frame(width: 20)
                Text(sentPulse ? "Sent" : preparing ? "Sending" : "Send")
                if preparing && !sentPulse {
                    ProgressView().controlSize(.small).tint(.white)
                }
            }
            .font(.system(size: 17, weight: .semibold))
            .padding(.horizontal, 22).frame(height: 56)
        }
        .buttonStyle(.glassProminent)
        // A fixed blue, so Send doesn't go grey (dimmed tint) whenever a popover is open.
        .tint(paired ? Color(red: 0, green: 0.48, blue: 1) : Color(red: 0.42, green: 0.55, blue: 0.75))
        .overlay(alignment: .topTrailing) {
            if pending > 0 {
                Text("\(pending)")
                    .font(.system(size: 13, weight: .bold)).monospacedDigit()
                    .foregroundStyle(.white)
                    .frame(minWidth: 22, minHeight: 22)
                    .background(.orange, in: Capsule())
                    .overlay(Capsule().stroke(.white, lineWidth: 2))
                    .offset(x: 6, y: -6)
                    .accessibilityLabel("\(pending) waiting for your Mac")
            }
        }
        .accessibilityIdentifier("send-button")
    }
}

/// Bars that follow the mic's level.
struct LevelMeter: View {
    let level: Float
    let active: Bool
    @State private var history: [Float] = Array(repeating: 0, count: 14)

    var body: some View {
        HStack(alignment: .center, spacing: 3) {
            ForEach(history.indices, id: \.self) { i in
                Capsule().fill(.white.opacity(active ? 0.95 : 0.5))
                    .frame(width: 5, height: max(4, CGFloat(history[i]) * 26))
            }
        }
        .animation(.linear(duration: 0.08), value: history)
        .onChange(of: level) { _, l in
            history.removeFirst()
            history.append(l)
        }
        .task {
            // While the mic is starting, a gentle idle wave.
            while !Task.isCancelled && !active {
                history.removeFirst()
                history.append(Float.random(in: 0.08 ... 0.25))
                try? await Task.sleep(for: .milliseconds(90))
            }
        }
        .accessibilityHidden(true)
    }
}


/// Reports a finger going down and coming up (or being cancelled) on a view that SwiftUI
/// doesn't rebuild while the button around it changes.
struct PressTracker: UIViewRepresentable {
    let changed: (Bool) -> Void

    func makeUIView(context: Context) -> UIView {
        let v = UIView()
        v.backgroundColor = .clear
        let press = UILongPressGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.handle(_:)))
        press.minimumPressDuration = 0
        press.allowableMovement = .greatestFiniteMagnitude
        press.cancelsTouchesInView = true
        v.addGestureRecognizer(press)
        return v
    }

    func updateUIView(_ uiView: UIView, context: Context) { context.coordinator.changed = changed }
    func makeCoordinator() -> Coordinator { Coordinator(changed: changed) }

    final class Coordinator: NSObject {
        var changed: (Bool) -> Void
        private var down = false
        init(changed: @escaping (Bool) -> Void) { self.changed = changed }

        @MainActor @objc func handle(_ g: UILongPressGestureRecognizer) {
            switch g.state {
            case .began:
                log.info("Press tracker began")
                down = true
                changed(true)
            case .ended, .cancelled, .failed:
                log.info("Press tracker ended \(g.state.rawValue)")
                guard down else { return }
                down = false
                changed(false)
            default: break
            }
        }
    }
}
