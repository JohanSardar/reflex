import Foundation

/// Fastest-path selection with hysteresis, the same rule as the Link
/// (`link/sync/paths.ts`). Every path to the Link stays open and anything
/// arriving on any of them is taken; this side sends over the active one.
///
///     score     = RTT (ms, smoothed)
///     switch    when another path's score has been under 0.75 × the active
///               one's, and at least 1 ms lower, for 4 s straight
///     fail over at once when the active path closes or goes silent
///
/// A path with no RTT yet never takes over from one that has one.
@MainActor
struct PathSet {
    static let switchRatio = 0.75
    static let minGainMs = 1.0
    static let hold: TimeInterval = 4
    /// Nothing heard for this long means the path is dead, even if its socket is open. Pings go every 2 s.
    static let silent: TimeInterval = 7

    private(set) var all: [Session] = []
    private(set) var active: Session?
    private var better: (session: Session, since: Date)?

    var isEmpty: Bool { all.isEmpty }

    func on(_ transport: String) -> Session? { all.first { $0.transport == transport } }

    static func score(_ s: Session) -> Double { s.rttMs ?? .infinity }

    mutating func add(_ s: Session) {
        all.append(s)
        if active == nil { active = s }
    }

    /// Removes a path. True if it was the active one (the best of the rest is then active).
    mutating func remove(_ s: Session) -> Bool {
        guard all.contains(where: { $0 === s }) else { return false }
        all.removeAll { $0 === s }
        if better?.session === s { better = nil }
        guard active === s else { return false }
        active = best()
        better = nil
        return true
    }

    private func best() -> Session? {
        all.min { Self.score($0) < Self.score($1) }
    }

    /// Re-checks the active path after a measurement. Returns the new active path if it switched.
    mutating func evaluate(now: Date = Date()) -> Session? {
        guard let cur = active, let best = best(), best !== cur else {
            better = nil
            return nil
        }
        let a = Self.score(cur), b = Self.score(best)
        guard b < a * Self.switchRatio, a - b >= Self.minGainMs else {
            better = nil
            return nil
        }
        if better?.session !== best { better = (best, now) }
        guard let since = better?.since, now.timeIntervalSince(since) >= Self.hold else { return nil }
        active = best
        better = nil
        return best
    }
}
