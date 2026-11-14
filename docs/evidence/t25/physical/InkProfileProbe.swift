
import os.signpost
import QuartzCore

/// Profiling-only, identical in both builds. Measures main-run-loop callback
/// spacing, not display presentation or touch-to-photon latency.
@MainActor final class InkProfileProbe: NSObject {
    static let shared = InkProfileProbe()
    let log = OSLog(subsystem: "si.eilmer.reflex.profile", category: .pointsOfInterest)
    var display: CADisplayLink?
    var last: CFTimeInterval = 0
    var active = false
    var ended: CFTimeInterval = 0
    var stroke: Int32 = 0
    func begin() {
        stroke += 1; active = true
        if display == nil {
            let d = CADisplayLink(target: self, selector: #selector(tick))
            d.add(to: .main, forMode: .common); display = d
        }
        last = CACurrentMediaTime()
        os_signpost(.event, log: log, name: "StrokeBegin", "stroke=%{public}d", stroke)
    }
    func end() {
        active = false; ended = CACurrentMediaTime()
        os_signpost(.event, log: log, name: "StrokeEnd", "stroke=%{public}d", stroke)
    }
    @objc func tick(_ d: CADisplayLink) {
        let now = CACurrentMediaTime(), gap = (now - last) * 1000
        if last > 0 && (active || now - ended < 0.5) {
            os_signpost(.event, log: log, name: "InkFrame", "stroke=%{public}d phase=%{public}d gap_ms=%{public}.3f", stroke, active ? Int32(1) : Int32(2), gap)
        }
        last = now
    }
}
