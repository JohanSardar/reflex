import AVFoundation
import OSLog
import Speech
import SwiftUI

private let log = Logger(subsystem: "si.eilmer.reflex", category: "voice")

/// Hold-to-talk speech, transcribed on this iPad with Apple's on-device SpeechAnalyzer (SPEC §10). Each hold is
/// also written to an audio file on this iPad, for Recordings. Audio never leaves the iPad; only the transcript and
/// its word timings go into a Send.
///
/// SpeechAnalyzer is made for long, natural speech: it keeps every finished sentence, through pauses and past a
/// minute, where SFSpeechRecognizer's live task started over after a pause (keeping only the last part) and ended
/// on its own after about a minute.
@MainActor @Observable
final class VoiceCapture {
    enum State: Equatable {
        case idle
        case listening
        case finishing
    }

    /// One hold, once it has ended: its words and where its audio is.
    struct Take {
        var started: Date
        var duration: TimeInterval
        var said: String
        var words: [Recording.Word]
        var levels: [Float]
        var audio: URL
    }

    private(set) var state: State = .idle
    /// What it has heard so far, while listening.
    private(set) var partial = ""
    /// The input level while listening, 0…1, for the meter.
    private(set) var level: Float = 0
    /// The person is holding the button (shown at once, before the mic is ready).
    var holding = false
    /// The system took the mic mid-hold (a call, another app, the route changed): the hold ends as cut off.
    @ObservationIgnored var onInterrupted: (() -> Void)?

    @ObservationIgnored private let engine = AVAudioEngine()
    @ObservationIgnored private var tape: Tape?
    @ObservationIgnored private var listener: Listener?
    @ObservationIgnored private var audio: URL?
    @ObservationIgnored private var started = Date()
    @ObservationIgnored private var observers: [NSObjectProtocol] = []

    init() {
        // Have this language's speech model ready before the first hold.
        if !Self.needsPermission { Task { _ = try? await SpeechModel.module() } }
        let center = NotificationCenter.default
        for name in [AVAudioSession.interruptionNotification, .AVAudioEngineConfigurationChange] {
            observers.append(
                center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated {
                        guard let self, self.state == .listening else { return }
                        log.info("The mic was taken mid-hold")
                        self.onInterrupted?()
                    }
                })
        }
    }

    /// True when the mic or speech recognition hasn't been allowed yet (or was refused).
    static var needsPermission: Bool {
        SFSpeechRecognizer.authorizationStatus() != .authorized
            || AVAudioApplication.shared.recordPermission != .granted
    }

    /// Asks for the mic and speech recognition, outside a hold. True if both are allowed. Then fetches this
    /// language's on-device speech model if the iPad doesn't have it yet, so the first hold can use it.
    func requestPermission() async -> Bool {
        let ok = await Self.allowed()
        if ok { Task { _ = try? await SpeechModel.module() } }
        return ok
    }

    /// Starts listening and recording to `file`. Throws a message the person can read if it can't.
    func start(recordingTo file: URL) async throws {
        guard state == .idle else { return }
        guard await Self.allowed() else {
            throw VoiceError("Reflex needs the microphone and speech recognition. Allow them in Settings.")
        }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .spokenAudio, options: .duckOthers)
        try session.setActive(true, options: .notifyOthersOnDeactivation)

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw VoiceError("No microphone is available.") }
        let tape = try Tape(file: file, format: format)
        self.tape = tape
        audio = file
        partial = ""
        input.removeTap(onBus: 0)
        Self.tap(input, format: format, into: tape) { [weak self] l in self?.level = l }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            tape.close()
            self.tape = nil
            throw error
        }
        started = Date()
        state = .listening
        // The recognizer gets ready while the mic already records: what's said meanwhile waits in the tape.
        let listener = Listener(input: format, audio: tape.stream) { [weak self] heard in self?.partial = heard }
        self.listener = listener
        log.info("Listening, on-device")
    }

    /// Stops listening and recording. The take's audio is complete on disk when this returns.
    func stop() async -> Take? {
        guard state == .listening, let tape, let audio else { return nil }
        state = .finishing
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        tape.close()
        let duration = Date().timeIntervalSince(started)
        let heard = await listener?.finish() ?? Heard(text: "", words: [])
        listener = nil
        self.tape = nil
        self.audio = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        state = .idle
        level = 0
        partial = ""
        log.info("Heard \(heard.text, privacy: .public) (\(heard.words.count) words, \(Int(duration)) s)")
        return Take(
            started: started, duration: duration, said: heard.text, words: heard.words,
            levels: tape.waveform(), audio: audio)
    }

    /// Transcribes a saved recording again, from its audio on this iPad.
    /// The audio goes through the same path as the mic's, in the format the recognizer asks for.
    static func transcribe(_ url: URL) async throws -> Heard {
        _ = try await SpeechModel.module()
        let file = try AVAudioFile(forReading: url)
        let format = file.processingFormat
        let seconds = Double(file.length) / format.sampleRate
        let (audio, input) = AsyncStream<Tape.Chunk>.makeStream()
        let listener = Listener(input: format, audio: audio) { _ in }
        // Decoded off the main actor.
        Task.detached {
            defer { input.finish() }
            guard let file = try? AVAudioFile(forReading: url) else { return }
            while let b = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 16_384),
                (try? file.read(into: b)) != nil, b.frameLength > 0
            {
                input.yield(Tape.Chunk(buffer: b))
            }
        }
        let heard = await listener.finish(patience: max(20, seconds))
        if heard.text.isEmpty, let failure = listener.failure { throw failure }
        return heard
    }

    // The tap calls back on its own queue, so its closure is made here, outside the main actor.
    private nonisolated static func tap(
        _ input: AVAudioInputNode, format: AVAudioFormat, into tape: Tape,
        level: @escaping @MainActor @Sendable (Float) -> Void
    ) {
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
            guard let data = buffer.floatChannelData?[0] else { return }
            let n = Int(buffer.frameLength)
            var sum: Float = 0
            for i in 0..<n { sum += data[i] * data[i] }
            let rms = sqrt(sum / Float(max(n, 1)))
            let l = min(1, max(0, (20 * log10(max(rms, 0.000_01)) + 50) / 45))
            tape.write(buffer, level: l)
            Task { @MainActor in level(l) }
        }
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

/// What was heard: the whole transcript, and each word's time from the start of the audio.
struct Heard: Sendable {
    var text: String
    var words: [Recording.Word]

    /// One result from the recognizer: finished (it won't change), or a guess at what's being said now.
    struct Piece: Sendable {
        var text: AttributedString
        var isFinal: Bool
    }

    /// Every finished piece, in order, until the recognizer ends.
    static func collect(_ pieces: AsyncThrowingStream<Piece, Error>) async throws -> Heard {
        var done: [AttributedString] = []
        for try await p in pieces where p.isFinal { done.append(p.text) }
        return Heard(done)
    }

    init(text: String, words: [Recording.Word]) {
        self.text = text
        self.words = words
    }

    /// Joins finished pieces, and any guess still pending at the end, into one transcript with word timings.
    init(_ pieces: [AttributedString]) {
        var parts: [String] = []
        var words: [Recording.Word] = []
        for piece in pieces {
            let s = String(piece.characters).trimmingCharacters(in: .whitespacesAndNewlines)
            if !s.isEmpty { parts.append(s) }
            for run in piece.runs {
                guard let range = run[AttributeScopes.SpeechAttributes.TimeRangeAttribute.self] else { continue }
                let w = String(piece[run.range].characters).trimmingCharacters(in: .whitespacesAndNewlines)
                guard !w.isEmpty, range.start.isNumeric, range.duration.isNumeric else { continue }
                words.append(.init(text: w, start: range.start.seconds, end: range.end.seconds))
            }
        }
        self.init(text: parts.joined(separator: " "), words: words)
    }
}

/// The on-device speech model for the person's language, and its results as plain pieces.
enum SpeechModel {
    static func module() async throws -> (any SpeechModule, AsyncThrowingStream<Heard.Piece, Error>) {
        let locale = Locale.current
        let module: any SpeechModule
        let pieces: AsyncThrowingStream<Heard.Piece, Error>
        if SpeechTranscriber.isAvailable, let l = await SpeechTranscriber.supportedLocale(equivalentTo: locale) {
            let t = SpeechTranscriber(
                locale: l, transcriptionOptions: [], reportingOptions: [.volatileResults],
                attributeOptions: [.audioTimeRange])
            module = t
            pieces = relay(t.results) { Heard.Piece(text: $0.text, isFinal: $0.isFinal) }
        } else if let l = await DictationTranscriber.supportedLocale(equivalentTo: locale) {
            // Where the long-form model isn't offered (some iPads and languages): dictation, still on this iPad.
            let t = DictationTranscriber(
                locale: l, contentHints: [], transcriptionOptions: [.punctuation], reportingOptions: [.volatileResults],
                attributeOptions: [.audioTimeRange])
            module = t
            pieces = relay(t.results) { Heard.Piece(text: $0.text, isFinal: $0.isFinal) }
        } else {
            throw VoiceError("On-device speech recognition isn't available on this iPad for \(locale.identifier).")
        }
        let status = await AssetInventory.status(forModules: [module])
        log.info(
            "Speech model \(String(describing: type(of: module)), privacy: .public): \(String(describing: status), privacy: .public)"
        )
        switch status {
        case .installed: break
        case .unsupported:
            throw VoiceError("On-device speech recognition isn't available on this iPad for \(locale.identifier).")
        case .supported, .downloading:
            if let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
                log.info("Downloading the on-device speech model")
                try await request.downloadAndInstall()
            }
        @unknown default: break
        }
        return (module, pieces)
    }

    private static func relay<S: AsyncSequence & Sendable>(
        _ results: S, _ piece: @escaping @Sendable (S.Element) -> Heard.Piece
    ) -> AsyncThrowingStream<Heard.Piece, Error> where S.Failure == any Error {
        AsyncThrowingStream { c in
            let task = Task {
                do {
                    for try await r in results { c.yield(piece(r)) }
                    c.finish()
                } catch { c.finish(throwing: error) }
            }
            c.onTermination = { _ in task.cancel() }
        }
    }
}

/// Feeds one hold's audio to SpeechAnalyzer and gathers what it hears, piece by piece.
@MainActor
private final class Listener {
    private var finished: [AttributedString] = []
    private var guess: AttributedString?
    private var analyzer: SpeechAnalyzer?
    private var input: AsyncStream<AnalyzerInput>.Continuation?
    private var work: Task<Void, Never>?
    private var results: Task<Void, Never>?
    private let heard: (String) -> Void
    /// Why the recognizer stopped early, if it did.
    private(set) var failure: Error?

    init(input format: AVAudioFormat, audio: AsyncStream<Tape.Chunk>, heard: @escaping (String) -> Void) {
        self.heard = heard
        work = Task { [weak self] in await self?.run(format, audio) }
    }

    private func run(_ format: AVAudioFormat, _ audio: AsyncStream<Tape.Chunk>) async {
        do {
            // If the model is still downloading (the first hold after allowing the mic), wait for it: the
            // audio queues in `audio` meanwhile, so the whole hold is still transcribed.
            let (module, pieces) = try await SpeechModel.module()
            let target = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module], considering: format)
            let analyzer = SpeechAnalyzer(modules: [module])
            self.analyzer = analyzer
            results = Task { [weak self] in
                do {
                    for try await p in pieces { self?.got(p) }
                } catch {
                    log.error("Speech results ended: \(error.localizedDescription, privacy: .public)")
                    self?.failure = error
                }
            }
            let (stream, input) = AsyncStream<AnalyzerInput>.makeStream()
            self.input = input
            try await analyzer.start(inputSequence: stream)
            let convert = Converter(from: format, to: target ?? format)
            for await chunk in audio {
                guard let b = convert(chunk.buffer) else { continue }
                input.yield(AnalyzerInput(buffer: b))
            }
            input.finish()
        } catch {
            log.error("Speech recognition didn't start: \(error.localizedDescription, privacy: .public)")
            failure = error
            // Recording goes on: the audio is saved, and Transcribe again can try later.
            for await _ in audio {}
        }
    }

    private func got(_ p: Heard.Piece) {
        if p.isFinal {
            finished.append(p.text)
            guess = nil
        } else {
            guess = p.text
        }
        heard(Heard(finished + (guess.map { [$0] } ?? [])).text)
    }

    /// Waits until everything recorded is transcribed, then returns all of it. Gives up after `patience`
    /// seconds: what's heard by then is kept, and the audio is saved either way.
    func finish(patience: Double = 20) async -> Heard {
        // All audio has gone in once the tape's stream is drained.
        await work?.value
        if let analyzer {
            let done = Task { try? await analyzer.finalizeAndFinishThroughEndOfInput() }
            let timeout = Task {
                try? await Task.sleep(for: .seconds(patience))
                await analyzer.cancelAndFinishNow()
            }
            await done.value
            timeout.cancel()
            // The results end with the analyzer; stop listening for them if they don't.
            let results = results
            let stop = Task {
                try? await Task.sleep(for: .seconds(5))
                results?.cancel()
            }
            await results?.value
            stop.cancel()
        }
        return Heard(finished + (guess.map { [$0] } ?? []))
    }
}

/// Converts the mic's buffers to the format the analyzer wants.
private final class Converter {
    private let converter: AVAudioConverter?
    private let target: AVAudioFormat

    init(from: AVAudioFormat, to: AVAudioFormat) {
        target = to
        converter = from == to ? nil : AVAudioConverter(from: from, to: to)
    }

    func callAsFunction(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let converter else { return buffer }
        let ratio = target.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 16
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return nil }
        nonisolated(unsafe) var fed = false
        nonisolated(unsafe) let buffer = buffer
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, outStatus in
            if fed {
                outStatus.pointee = .noDataNow
                return nil
            }
            fed = true
            outStatus.pointee = .haveData
            return buffer
        }
        guard status != .error, out.frameLength > 0 else { return nil }
        return out
    }
}

/// One hold's audio as it's recorded: written to a file on this iPad, and handed on for transcription.
/// Called from the audio tap's queue, so it guards itself.
final class Tape: @unchecked Sendable {
    struct Chunk: @unchecked Sendable { let buffer: AVAudioPCMBuffer }

    let stream: AsyncStream<Chunk>
    private let continuation: AsyncStream<Chunk>.Continuation
    private let lock = NSLock()
    private var file: AVAudioFile?
    private var levels: [Float] = []

    init(file url: URL, format: AVAudioFormat) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        // AAC as an ADTS stream (.aac): small, and each frame stands alone, so what was recorded is still
        // readable if the app stops mid-hold (an AAC .caf or .m4a needs its index written at the end).
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: format.sampleRate,
            AVNumberOfChannelsKey: format.channelCount, AVEncoderBitRateKey: 64_000,
        ]
        file = try AVAudioFile(
            forWriting: url, settings: settings, commonFormat: format.commonFormat, interleaved: format.isInterleaved)
        (stream, continuation) = AsyncStream<Chunk>.makeStream()
    }

    func write(_ buffer: AVAudioPCMBuffer, level: Float) {
        // The tap reuses its buffer: keep a copy for the recognizer.
        guard let copy = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength) else { return }
        copy.frameLength = buffer.frameLength
        let channels = Int(buffer.format.channelCount)
        if let src = buffer.floatChannelData, let dst = copy.floatChannelData {
            for c in 0..<(buffer.format.isInterleaved ? 1 : channels) {
                dst[c].update(
                    from: src[c], count: Int(buffer.frameLength) * (buffer.format.isInterleaved ? channels : 1))
            }
        }
        lock.withLock {
            guard let file else { return }
            do { try file.write(from: buffer) } catch {
                log.error("Could not write the recording: \(error.localizedDescription, privacy: .public)")
            }
            levels.append(level)
        }
        continuation.yield(Chunk(buffer: copy))
    }

    func close() {
        lock.withLock {
            file?.close()
            file = nil
        }
        continuation.finish()
    }

    /// The recording's loudness as 48 bars, for its row in Recordings.
    func waveform(bars: Int = 48) -> [Float] {
        let all = lock.withLock { levels }
        guard !all.isEmpty else { return [] }
        return (0..<bars).map { i in
            let lo = i * all.count / bars
            let hi = max(lo + 1, (i + 1) * all.count / bars)
            return all[lo..<min(hi, all.count)].max() ?? 0
        }
    }
}

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
    /// Where a new hold's audio is saved.
    let recordTo: () -> URL
    /// A hold ended with something recorded: released, or cut off (a cancelled touch, the mic taken away).
    let onTake: (_ take: VoiceCapture.Take, _ cutOff: Bool) -> Void
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
        .onAppear { voice.onInterrupted = { pressEnded(cancelled: true) } }
        .onChange(of: lastSend) { _, _ in
            sentPulse = true
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            Task {
                try? await Task.sleep(for: .seconds(1.4))
                sentPulse = false
            }
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
                    Text(
                        Duration.seconds(max(0, ctx.date.timeIntervalSince(started))).formatted(
                            .time(pattern: .minuteSecond))
                    )
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
            PressTracker { down, cancelled in
                if down { pressBegan() } else { pressEnded(cancelled: cancelled) }
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
                onFail(
                    ok
                        ? "Ready. Hold the mic and talk, then let go to Send."
                        : "Reflex needs the microphone and speech recognition. Allow them in Settings.")
            }
            return
        }
        voice.holding = true
        started = Date()
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        let file = recordTo()
        starting = Task {
            do {
                try await voice.start(recordingTo: file)
                return true
            } catch {
                voice.holding = false
                onFail(error.localizedDescription)
                return false
            }
        }
    }

    /// Release, or a touch the system cancelled (an alert, a palm): either way recording ends, and the
    /// recording is kept. Only a release Sends.
    private func pressEnded(cancelled: Bool = false) {
        log.info(
            "Mic press ended (holding \(voice.holding), state \(String(describing: voice.state), privacy: .public), cancelled \(cancelled))"
        )
        pressed = false
        if permissionTouch {
            permissionTouch = false
            return
        }
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
            guard let take = await voice.stop() else { return }
            onTake(take, cancelled)
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
                history.append(Float.random(in: 0.08...0.25))
                try? await Task.sleep(for: .milliseconds(90))
            }
        }
        .accessibilityHidden(true)
    }
}

/// Reports a finger going down and coming up (or being cancelled) on a view that SwiftUI
/// doesn't rebuild while the button around it changes.
struct PressTracker: UIViewRepresentable {
    /// Down, or up; up says whether the system cancelled the touch.
    let changed: (_ down: Bool, _ cancelled: Bool) -> Void

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
        var changed: (Bool, Bool) -> Void
        private var down = false
        init(changed: @escaping (Bool, Bool) -> Void) { self.changed = changed }

        @MainActor @objc func handle(_ g: UILongPressGestureRecognizer) {
            switch g.state {
            case .began:
                log.info("Press tracker began")
                down = true
                changed(true, false)
            case .ended, .cancelled, .failed:
                log.info("Press tracker ended \(g.state.rawValue)")
                guard down else { return }
                down = false
                changed(false, g.state != .ended)
            default: break
            }
        }
    }
}
