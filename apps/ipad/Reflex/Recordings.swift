import AVFoundation
import OSLog
import SwiftUI

private let log = Logger(subsystem: "si.eilmer.reflex", category: "recordings")

/// One hold of the mic, kept on this iPad until the person deletes it: its audio and its words.
struct Recording: Codable, Identifiable, Hashable {
    struct Word: Codable, Hashable, Sendable {
        var text: String
        /// Seconds from the start of the recording.
        var start: Double
        var end: Double
    }

    /// One time it went out in a Send.
    struct Sent: Codable, Hashable {
        var send: String
        var at: Date
        /// The Agents the Link gives Sends to, when it went out.
        var to: [String]
        /// The Mac has it (the Link acknowledged the Send).
        var delivered = false
    }

    var id: String
    /// When the hold began.
    var at: Date
    var duration: Double = 0
    var said = ""
    var words: [Word] = []
    var levels: [Float] = []
    /// The hold was cut off (a cancelled touch, the mic taken away, the app stopped) rather than released.
    var cutOff = false
    /// Still being recorded. One left like this by an earlier launch was cut off by the app stopping.
    var recording = false
    /// The launch that recorded it, while it's being recorded.
    var launch: String?
    var sends: [Sent] = []

    var delivered: Sent? { sends.last { $0.delivered } }
    var waiting: Bool { delivered == nil && !sends.isEmpty }
    var heardNothing: Bool { said.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// The words for a Send, timed on the clock strokes use (ms since 1970), as when they were said.
    var sendWords: [[String: Any]] {
        let base = at.timeIntervalSince1970
        return words.map {
            [
                "text": $0.text, "start_ms": Int(((base + $0.start) * 1000).rounded()),
                "end_ms": Int(((base + $0.end) * 1000).rounded()),
            ]
        }
    }
}

/// Every recording on this iPad, under Application Support/Reflex/Recordings: `<id>.aac` and `<id>.json`.
/// Audio never leaves the iPad.
@MainActor @Observable
final class RecordingStore {
    private(set) var all: [Recording] = []
    /// Recordings the Mac doesn't have yet, for the badge.
    var unsent: Int { all.filter { $0.delivered == nil }.count }
    /// Bumps when a recording is saved without going out, so the button can say so.
    private(set) var savedUnsent = 0

    static let dir = URL.applicationSupportDirectory.appending(path: "Reflex/Recordings", directoryHint: .isDirectory)
    /// One store for the app: SwiftUI may build a view's initial state more than once, and a second store must
    /// never tidy up a hold that is still being recorded.
    static let shared = RecordingStore()
    private static let launch = UUID().uuidString

    private init() {
        try? FileManager.default.createDirectory(at: Self.dir, withIntermediateDirectories: true)
        load()
    }

    func audioURL(_ id: String) -> URL { Self.dir.appending(path: id + ".aac") }

    /// A new recording's ID and where its audio goes. Saved at once, so a hold the app doesn't live through is
    /// still found (as cut off) next time.
    func begin() -> URL {
        let id = "rec_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        save(Recording(id: id, at: Date(), recording: true, launch: Self.launch))
        return audioURL(id)
    }

    /// The take is complete on disk: keep its words and length. Returns the saved recording.
    @discardableResult
    func finish(_ take: VoiceCapture.Take, cutOff: Bool) -> Recording {
        let id = take.audio.deletingPathExtension().lastPathComponent
        var r = Recording(id: id, at: take.started)
        r.at = take.started
        r.duration = take.duration
        r.said = take.said
        r.words = take.words
        r.levels = take.levels
        r.cutOff = cutOff
        r.recording = false
        r.launch = nil
        put(r)
        log.info("Saved recording \(id, privacy: .public): \(Int(take.duration)) s, \(take.words.count) words")
        return r
    }

    /// The press was too short to be a recording: nothing to keep.
    func discard(_ take: VoiceCapture.Take) { delete(take.audio.deletingPathExtension().lastPathComponent) }

    func noteUnsent() { savedUnsent += 1 }

    /// A Send with this recording's words is saved in the outbox.
    func queued(_ id: String, send: String, to agents: [String]) {
        guard var r = all.first(where: { $0.id == id }) else { return }
        r.sends.append(.init(send: send, at: Date(), to: agents))
        put(r)
    }

    /// Marks Sends the Link has acknowledged (they've left the outbox).
    func refresh(stillPending: (String) -> Bool) {
        for var r in all where r.sends.contains(where: { !$0.delivered && !stillPending($0.send) }) {
            for i in r.sends.indices where !r.sends[i].delivered && !stillPending(r.sends[i].send) {
                r.sends[i].delivered = true
            }
            put(r)
        }
    }

    func update(_ id: String, heard: Heard) {
        guard var r = all.first(where: { $0.id == id }) else { return }
        r.said = heard.text
        r.words = heard.words
        put(r)
    }

    func delete(_ id: String) {
        all.removeAll { $0.id == id }
        try? FileManager.default.removeItem(at: audioURL(id))
        try? FileManager.default.removeItem(at: Self.dir.appending(path: id + ".json"))
    }

    private func put(_ r: Recording) {
        save(r)
        if let i = all.firstIndex(where: { $0.id == r.id }) { all[i] = r } else { all.insert(r, at: 0) }
        all.sort { $0.at > $1.at }
    }

    private func save(_ r: Recording) {
        do {
            let enc = JSONEncoder()
            enc.dateEncodingStrategy = .millisecondsSince1970
            try enc.encode(r).write(
                to: Self.dir.appending(path: r.id + ".json"), options: [.atomic, .completeFileProtectionUnlessOpen])
        } catch { log.error("Could not save recording \(r.id, privacy: .public): \(error.localizedDescription)") }
    }

    private func load() {
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .millisecondsSince1970
        let files = (try? FileManager.default.contentsOfDirectory(at: Self.dir, includingPropertiesForKeys: nil)) ?? []
        var list: [Recording] = []
        for f in files where f.pathExtension == "json" {
            guard let data = try? Data(contentsOf: f), var r = try? dec.decode(Recording.self, from: data) else {
                continue
            }
            if r.recording {
                // Being recorded right now: finish() saves it.
                guard r.launch != Self.launch else { continue }
                // The app stopped mid-hold: keep what was recorded, as cut off.
                r.recording = false
                r.launch = nil
                r.cutOff = true
                if let file = try? AVAudioFile(forReading: audioURL(r.id)) {
                    r.duration = Double(file.length) / file.fileFormat.sampleRate
                }
                if r.duration < 0.5 {
                    try? FileManager.default.removeItem(at: f)
                    try? FileManager.default.removeItem(at: audioURL(r.id))
                    continue
                }
                save(r)
            }
            list.append(r)
        }
        all = list.sorted { $0.at > $1.at }
    }
}

/// Plays one recording at a time.
@MainActor @Observable
final class RecordingPlayer: NSObject, AVAudioPlayerDelegate {
    private(set) var playing: String?
    @ObservationIgnored private var player: AVAudioPlayer?

    var progress: Double {
        guard let player, player.duration > 0 else { return 0 }
        return player.currentTime / player.duration
    }

    func toggle(_ r: Recording, url: URL) {
        if playing == r.id { return stop() }
        stop()
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .spokenAudio)
            try session.setActive(true)
            let p = try AVAudioPlayer(contentsOf: url)
            p.delegate = self
            p.play()
            player = p
            playing = r.id
        } catch { log.error("Could not play \(r.id, privacy: .public): \(error.localizedDescription)") }
    }

    func stop() {
        player?.stop()
        player = nil
        if playing != nil {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
        playing = nil
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        MainActor.assumeIsolated { stop() }
    }
}

// MARK: Views

/// The Recordings button beside the mic: a badge counts recordings the Mac doesn't have yet.
struct RecordingsButton: View {
    let store: RecordingStore
    let action: () -> Void
    @State private var bump = false

    var body: some View {
        Button(action: action) {
            Image(systemName: "waveform")
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(.primary)
                .frame(width: 56, height: 56)
                .background(Color(.tertiarySystemBackground).opacity(0.9), in: Circle())
                .glassEffect(.regular, in: Circle())
        }
        .buttonStyle(.plain)
        .scaleEffect(bump ? 1.18 : 1)
        .overlay(alignment: .topTrailing) {
            if store.unsent > 0 {
                Text("\(store.unsent)")
                    .font(.system(size: 13, weight: .bold)).monospacedDigit()
                    .foregroundStyle(.white)
                    .frame(minWidth: 22, minHeight: 22)
                    .background(.orange, in: Capsule())
                    .overlay(Capsule().stroke(.white, lineWidth: 2))
                    .offset(x: 4, y: -4)
                    .allowsHitTesting(false)
            }
        }
        .onChange(of: store.savedUnsent) { _, _ in
            withAnimation(.spring(duration: 0.2)) { bump = true }
            Task {
                try? await Task.sleep(for: .milliseconds(220))
                withAnimation(.spring(duration: 0.25)) { bump = false }
            }
        }
        .accessibilityLabel(store.unsent > 0 ? "Recordings, \(store.unsent) not sent" : "Recordings")
        .accessibilityIdentifier("recordings-button")
    }
}

/// The list of recordings, newest first. Tap one to play it, read all its words, Send it again with the board,
/// transcribe it again from its audio, or delete it.
struct RecordingsPanel: View {
    let store: RecordingStore
    let player: RecordingPlayer
    let canSend: Bool
    let send: (Recording) -> Void
    let done: () -> Void
    @State private var open: String?
    @State private var transcribing: Set<String> = []
    /// What just happened, said inside the panel (the board's notices are under it).
    @State private var message: String?

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Recordings").font(.headline)
                Spacer()
                Button("Done", action: done).buttonStyle(.bordered).buttonBorderShape(.capsule)
                    .accessibilityIdentifier("recordings-done")
            }
            .padding(.horizontal, 18).padding(.top, 16).padding(.bottom, 8)
            if let message {
                Text(message)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(Color.black.opacity(0.8), in: Capsule())
                    .padding(.bottom, 6)
                    .transition(.opacity)
                    .accessibilityIdentifier("recordings-message")
            }
            if store.all.isEmpty {
                Text("No recordings yet. Hold the mic and talk.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity).padding(24)
            } else {
                ScrollView {
                    LazyVStack(spacing: 2) {
                        ForEach(store.all) { r in row(r) }
                    }
                    .padding(.horizontal, 10).padding(.vertical, 4)
                }
                .frame(maxHeight: 520)
            }
            Divider()
            Text("Kept only on this iPad. Audio never leaves it; a Send carries only the words.")
                .font(.caption).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 18).padding(.top, 8).padding(.bottom, 14)
        }
        .frame(width: 400)
        .animation(.easeInOut(duration: 0.2), value: message)
        .onDisappear { player.stop() }
        .accessibilityIdentifier("recordings-panel")
    }

    private func row(_ r: Recording) -> some View {
        let isOpen = open == r.id
        return HStack(alignment: .top, spacing: 12) {
            Button {
                open = r.id
                player.toggle(r, url: store.audioURL(r.id))
            } label: {
                Image(systemName: player.playing == r.id ? "pause.fill" : "play.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 40, height: 40)
                    .background(Color(.systemBackground), in: Circle())
                    .overlay(Circle().stroke(Color.primary.opacity(0.08)))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(player.playing == r.id ? "Pause" : "Play")
            .accessibilityIdentifier("recording-play")
            VStack(alignment: .leading, spacing: 4) {
                Group {
                    if r.heardNothing {
                        Text("No words heard").italic().foregroundStyle(.secondary)
                    } else {
                        Text(r.said)
                    }
                }
                .lineLimit(isOpen ? nil : 2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("recording-text")
                HStack(spacing: 6) {
                    Text(Self.length(r.duration)).monospacedDigit()
                    Text("·")
                    Text(r.at, format: .relative(presentation: .named))
                    tag(r)
                }
                .font(.footnote).foregroundStyle(.secondary)
                if isOpen {
                    if !r.levels.isEmpty {
                        Wave(levels: r.levels, progress: player.playing == r.id ? player : nil)
                            .frame(height: 28).padding(.top, 4)
                    }
                    if let sent = r.delivered, sent.to.count > 1 {
                        Text("Sent to \(sent.to.joined(separator: ", "))")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    actions(r)
                }
            }
        }
        .padding(10)
        .background(
            isOpen ? Color.accentColor.opacity(0.08) : Color.clear, in: RoundedRectangle(cornerRadius: 16)
        )
        .contentShape(RoundedRectangle(cornerRadius: 16))
        .onTapGesture { withAnimation(.snappy) { open = isOpen ? nil : r.id } }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("recording-row")
    }

    @ViewBuilder private func tag(_ r: Recording) -> some View {
        let (text, color): (String, Color) =
            if let sent = r.delivered {
                ("Sent to \(Self.agents(sent.to))", .green)
            } else if r.waiting {
                ("Waiting for your Mac", .orange)
            } else if r.cutOff {
                ("Cut off · not sent", .orange)
            } else {
                ("Not sent", .orange)
            }
        Text(text)
            .font(.caption.weight(.semibold))
            .lineLimit(1)
            .padding(.horizontal, 6).padding(.vertical, 1)
            .foregroundStyle(
                color == .green ? Color(red: 0.12, green: 0.54, blue: 0.23) : Color(red: 0.72, green: 0.36, blue: 0)
            )
            .background(color.opacity(0.14), in: RoundedRectangle(cornerRadius: 6))
            .accessibilityIdentifier("recording-status")
    }

    private func actions(_ r: Recording) -> some View {
        HStack(spacing: 8) {
            Button(r.sends.isEmpty ? "Send" : "Send again") { send(r) }
                .buttonStyle(.borderedProminent)
                .disabled(r.heardNothing || !canSend)
                .accessibilityIdentifier("recording-send")
            Button {
                retranscribe(r)
            } label: {
                if transcribing.contains(r.id) {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.small)
                        Text("Transcribing")
                    }
                } else {
                    Text("Transcribe again")
                }
            }
            .buttonStyle(.bordered).tint(.secondary)
            .disabled(transcribing.contains(r.id))
            .accessibilityIdentifier("recording-transcribe")
            Button("Delete", role: .destructive) {
                if player.playing == r.id { player.stop() }
                withAnimation(.snappy) { store.delete(r.id) }
                if open == r.id { open = nil }
                note("Recording deleted")
            }
            .buttonStyle(.borderless)
            .accessibilityIdentifier("recording-delete")
        }
        .buttonBorderShape(.capsule)
        .controlSize(.small)
        .font(.subheadline.weight(.semibold))
        .lineLimit(1)
        .padding(.top, 6)
    }

    private func retranscribe(_ r: Recording) {
        transcribing.insert(r.id)
        note("Transcribing again from the saved audio…")
        let url = store.audioURL(r.id)
        Task {
            defer { transcribing.remove(r.id) }
            do {
                let heard = try await VoiceCapture.transcribe(url)
                store.update(r.id, heard: heard)
                note(heard.text.isEmpty ? "Still no words heard in that recording." : "Transcribed again")
            } catch {
                log.error("Transcribe again failed: \(error.localizedDescription, privacy: .public)")
                note("Couldn't transcribe it: \(error.localizedDescription)")
            }
        }
    }

    private func note(_ text: String) {
        message = text
        Task {
            try? await Task.sleep(for: .seconds(2.5))
            if message == text { message = nil }
        }
    }

    static func length(_ s: Double) -> String {
        Duration.seconds(max(0, s.rounded())).formatted(.time(pattern: .minuteSecond))
    }

    static func agents(_ names: [String]) -> String {
        switch names.count {
        case 0: "your Mac"
        case 1: names[0]
        default: "\(names.count) agents"
        }
    }
}

/// The recording's loudness as bars, filled in as it plays.
private struct Wave: View {
    let levels: [Float]
    let progress: RecordingPlayer?

    var body: some View {
        TimelineView(.animation(minimumInterval: 0.1, paused: progress == nil)) { _ in
            let p = progress?.progress ?? 0
            HStack(alignment: .center, spacing: 2) {
                ForEach(Array(levels.enumerated()), id: \.offset) { i, l in
                    Capsule()
                        .fill(Double(i) / Double(max(levels.count, 1)) < p ? Color.accentColor : Color(.systemGray3))
                        .frame(maxWidth: .infinity)
                        .frame(height: max(3, CGFloat(l) * 28))
                }
            }
        }
        .accessibilityHidden(true)
    }
}
