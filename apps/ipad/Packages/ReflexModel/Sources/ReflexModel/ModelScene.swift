import Foundation
import Observation
import OSLog
import RealityKit
import simd
import UIKit

private let log = Logger(subsystem: "si.eilmer.reflex", category: "model")

/// One 3D Embed on the iPad (SPEC §5, "3D"): its model drawn with RealityKit in a non-AR view,
/// with the orbit camera every device uses (`agent/src/model.ts`), the Agent's part settings
/// (`params.parts`) and the person's moves (state `"part:<name>"`). It turns the person's touches
/// into camera moves and part drags, and answers what a Mark drawn over it points at.
///
/// Coordinates in and out are the view's own points, which are the Embed's points in the Space.
@MainActor @Observable
public final class ModelScene {
    public let view: ARView
    /// Why the model isn't showing, if it isn't.
    public private(set) var note: String?
    /// The model's parts, by name.
    public private(set) var partNames: [String] = []
    /// What the view showed last, for Send crops (Metal content isn't in a view snapshot).
    public private(set) var snapshot: UIImage?

    /// Vertical field of view in degrees, as on the web and in `look`.
    public static let fov: Float = 40

    @ObservationIgnored private let anchor = AnchorEntity(world: .zero)
    @ObservationIgnored private let camera = PerspectiveCamera()
    @ObservationIgnored private let light = DirectionalLight()
    @ObservationIgnored private var model: Entity?
    @ObservationIgnored private var parts: [String: Entity] = [:]
    @ObservationIgnored private var original: [ObjectIdentifier: Transform] = [:]
    /// Mesh entities with their triangles (GLB), for exact picking; empty for USDZ, which uses collision boxes.
    @ObservationIgnored private var meshes: [(ModelEntity, GLB.Primitive)] = []
    @ObservationIgnored private var params: [String: Any] = [:]
    @ObservationIgnored private var state: [String: Any] = [:]
    @ObservationIgnored private var center = SIMD3<Float>.zero
    @ObservationIgnored private var radius: Float = 1
    @ObservationIgnored private var orbit = (yaw: Float(35), pitch: Float(25), zoom: Float(1))
    @ObservationIgnored private var panOffset = SIMD3<Float>.zero
    @ObservationIgnored private var placedCamera = false
    /// The part being dragged: its name, the plane it moves in, where the finger first hit, and where the part started.
    @ObservationIgnored private var drag: (name: String, normal: SIMD3<Float>, hit: SIMD3<Float>, start: SIMD3<Float>)?
    @ObservationIgnored private var snapTask: Task<Void, Never>?
    @ObservationIgnored private var loading = false
    public let modelRef: String

    public init(modelRef: String) {
        self.modelRef = modelRef
        view = ARView(frame: CGRect(x: 0, y: 0, width: 400, height: 300), cameraMode: .nonAR, automaticallyConfigureSession: false)
        view.environment.background = .color(.white)
        view.renderOptions.insert(.disableMotionBlur)
        view.isUserInteractionEnabled = false
        camera.camera.fieldOfViewInDegrees = Self.fov
        light.light.intensity = 2500
        anchor.addChild(camera)
        anchor.addChild(light)
        view.scene.addAnchor(anchor)
        note = "Loading the model…"
    }

    public var loaded: Bool { model != nil }

    // MARK: Loading

    /// Loads the model from its bytes: a GLB through `GLB`, a USDZ through RealityKit.
    public func load(_ data: Data) async {
        guard model == nil, !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let root: Entity
            if GLB.isGLB(data) {
                let built = try GLB(data).build()
                root = built.root
                meshes = built.meshes
                findParts(root) { $0.parent != nil }
            } else {
                let url = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString).usdz")
                try data.write(to: url)
                defer { try? FileManager.default.removeItem(at: url) }
                root = try await Entity(contentsOf: url)
                root.generateCollisionShapes(recursive: true)
                findParts(root) { _ in true }
            }
            anchor.addChild(root)
            model = root
            let b = root.visualBounds(relativeTo: nil)
            center = b.center
            radius = max(1e-6, length(b.extents) / 2)
            note = nil
            apply()
            if !placedCamera { setCamera(params["camera"] as? [String: Any]) }
            refreshSnapshot()
        } catch {
            note = "This model can't be shown: \(error.localizedDescription)"
            log.error("Model \(self.modelRef, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Named entities that hold a mesh, except one holding every mesh (the whole model) when there are others.
    private func findParts(_ root: Entity, _ isNode: (Entity) -> Bool) {
        func meshCount(_ e: Entity) -> Int { (e.components.has(ModelComponent.self) ? 1 : 0) + e.children.reduce(0) { $0 + meshCount($1) } }
        let total = meshCount(root)
        var named: [Entity] = []
        func walk(_ e: Entity) {
            if e !== root, !e.name.isEmpty, isNode(e), meshCount(e) > 0 { named.append(e) }
            e.children.forEach(walk)
        }
        walk(root)
        for e in named where (named.count == 1 || meshCount(e) < total) && parts[e.name] == nil {
            parts[e.name] = e
            original[ObjectIdentifier(e)] = e.transform
        }
        partNames = named.map(\.name).filter { parts[$0] != nil }
    }

    // MARK: Settings

    /// The Agent's `params` and the person's `state` changed (or arrived): apply them.
    public func update(params: [String: Any], state: [String: Any]) {
        self.params = params
        self.state = state
        guard model != nil else { return }
        apply()
        refreshSnapshot()
    }

    private static func vec3(_ v: Any?) -> SIMD3<Float>? {
        guard let a = v as? [Any], a.count == 3 else { return nil }
        let f = a.compactMap { ($0 as? NSNumber)?.floatValue ?? ($0 as? Double).map(Float.init) }
        return f.count == 3 ? SIMD3(f[0], f[1], f[2]) : nil
    }

    private static func same(_ a: Any?, _ b: Any?) -> Bool {
        switch (vec3(a), vec3(b)) {
        case (nil, nil): (a == nil || a is NSNull) && (b == nil || b is NSNull)
        case let (x?, y?): x == y
        default: false
        }
    }

    /// Where the Agent put a part (its params position), or nil when it left it where the model has it.
    private func agentPosition(_ name: String) -> SIMD3<Float>? {
        Self.vec3(((params["parts"] as? [String: Any])?[name] as? [String: Any])?["position"])
    }

    private func apply() {
        let settings = params["parts"] as? [String: Any] ?? [:]
        for (name, e) in parts {
            if drag?.name == name { continue }
            var t = original[ObjectIdentifier(e)] ?? .identity
            let s = settings[name] as? [String: Any] ?? [:]
            if let p = Self.vec3(s["position"]) { t.translation = p }
            if let r = s["rotation"] as? [Any] {
                let f = r.compactMap { ($0 as? NSNumber)?.floatValue }
                if f.count == 4 { t.rotation = simd_quatf(ix: f[0], iy: f[1], iz: f[2], r: f[3]) }
                if f.count == 3 {
                    let rad = f.map { $0 * .pi / 180 }
                    t.rotation = simd_quatf(angle: rad[2], axis: [0, 0, 1]) * simd_quatf(angle: rad[1], axis: [0, 1, 0]) * simd_quatf(angle: rad[0], axis: [1, 0, 0])
                }
            }
            if let sc = (s["scale"] as? NSNumber)?.floatValue { t.scale = SIMD3(repeating: sc) } else if let sc = Self.vec3(s["scale"]) { t.scale = sc }
            // The person's move stands unless the Agent set this part's position since.
            if let moved = state["part:\(name)"] as? [String: Any], let p = Self.vec3(moved["position"]),
               s["position"] == nil || Self.same(s["position"], moved["base"]) {
                t.translation = p
            }
            e.transform = t
            e.isEnabled = (s["hidden"] as? Bool) != true
            let hl: UIColor? = switch s["highlight"] {
            case let name as String: Self.colors[name] ?? Self.colors["orange"]
            case let on as Bool where on: Self.colors["orange"]
            default: nil
            }
            for (me, prim) in meshes where Self.under(me, e) {
                me.model?.materials = [GLB.material(prim, highlight: hl)]
            }
        }
    }

    static let colors: [String: UIColor] = [
        "red": UIColor(red: 0.9, green: 0.28, blue: 0.3, alpha: 1), "orange": UIColor(red: 0.97, green: 0.42, blue: 0.08, alpha: 1),
        "yellow": UIColor(red: 0.96, green: 0.77, blue: 0, alpha: 1), "green": UIColor(red: 0.19, green: 0.64, blue: 0.42, alpha: 1),
        "teal": UIColor(red: 0.07, green: 0.65, blue: 0.58, alpha: 1), "blue": UIColor(red: 0, green: 0.56, blue: 1, alpha: 1),
        "violet": UIColor(red: 0.43, green: 0.34, blue: 0.81, alpha: 1), "pink": UIColor(red: 0.84, green: 0.25, blue: 0.62, alpha: 1),
        "black": UIColor(red: 0.11, green: 0.11, blue: 0.12, alpha: 1), "grey": UIColor(red: 0.56, green: 0.56, blue: 0.58, alpha: 1),
        "white": .white,
    ]

    // MARK: Camera

    private var fitDistance: Float {
        let half = Self.fov * .pi / 360
        let aspect = Float(max(1, view.bounds.width) / max(1, view.bounds.height))
        return radius / sin(min(half, atan(tan(half) * aspect)))
    }

    private func setCamera(_ c: [String: Any]?) {
        orbit = ((c?["yaw"] as? NSNumber)?.floatValue ?? 35, (c?["pitch"] as? NSNumber)?.floatValue ?? 25, (c?["zoom"] as? NSNumber)?.floatValue ?? 1)
        placedCamera = true
        place()
    }

    private func place() {
        let yaw = orbit.yaw * .pi / 180
        let pitch = max(-89, min(89, orbit.pitch)) * .pi / 180
        let d = fitDistance * 1.05 / max(0.05, orbit.zoom)
        let target = center + panOffset
        let position = target + d * SIMD3(sin(yaw) * cos(pitch), sin(pitch), cos(yaw) * cos(pitch))
        camera.look(at: target, from: position, relativeTo: nil)
        camera.camera.near = d / 1000
        camera.camera.far = d * 100
        light.look(at: target, from: position + SIMD3(0, d, 0), relativeTo: nil)
    }

    /// The view was laid out at a new size.
    public func resized() {
        guard model != nil else { return }
        place()
    }

    /// One finger on empty space or a part: turn around the model.
    public func orbit(by d: CGSize) {
        orbit.yaw -= Float(d.width) * 0.4
        orbit.pitch = max(-89, min(89, orbit.pitch + Float(d.height) * 0.4))
        place()
    }

    /// Two fingers: slide the model in the view.
    public func pan(by d: CGSize) {
        let dist = fitDistance * 1.05 / max(0.05, orbit.zoom)
        let perPoint = 2 * dist * tan(Self.fov * .pi / 360) / Float(max(1, view.bounds.height))
        let m = camera.transformMatrix(relativeTo: nil)
        let right = SIMD3(m.columns.0.x, m.columns.0.y, m.columns.0.z)
        let up = SIMD3(m.columns.1.x, m.columns.1.y, m.columns.1.z)
        panOffset += (-Float(d.width) * right + Float(d.height) * up) * perPoint
        place()
    }

    /// A pinch: closer or farther.
    public func zoom(by scale: CGFloat) {
        orbit.zoom = max(0.2, min(20, orbit.zoom * Float(scale)))
        place()
    }

    /// The person let go: keep a picture of what the view shows now.
    public func interactionEnded() { refreshSnapshot() }

    /// The camera as a Mark records it.
    public var pose: [String: Any] {
        let m = camera.transformMatrix(relativeTo: nil)
        let p = SIMD3(m.columns.3.x, m.columns.3.y, m.columns.3.z)
        let t = center + panOffset
        let r = { (x: Float) in (Double(x) * 1e4).rounded() / 1e4 }
        return [
            "yaw": r(orbit.yaw), "pitch": r(orbit.pitch), "zoom": r(orbit.zoom),
            "position": [r(p.x), r(p.y), r(p.z)], "target": [r(t.x), r(t.y), r(t.z)], "fov": Double(Self.fov),
        ]
    }

    // MARK: Picking

    private func ray(_ p: CGPoint) -> (origin: SIMD3<Float>, direction: SIMD3<Float>)? {
        view.ray(through: p)
    }

    /// The part under a point, and where the ray hit it, nearest first.
    public func part(at p: CGPoint) -> (name: String, hit: SIMD3<Float>)? {
        guard model != nil, let r = ray(p) else { return nil }
        if meshes.isEmpty {
            // USDZ: RealityKit's collision boxes.
            guard let hit = view.hitTest(p).first, let name = owner(hit.entity) else { return nil }
            return (name, hit.position)
        }
        var best: (t: Float, name: String, hit: SIMD3<Float>)?
        for (me, prim) in meshes where me.isEnabledInHierarchy {
            guard let name = owner(me) else { continue }
            let w = me.transformMatrix(relativeTo: nil)
            let inv = w.inverse
            let o4 = inv * SIMD4(r.origin, 1), d4 = inv * SIMD4(r.direction, 0)
            let o = SIMD3(o4.x, o4.y, o4.z), d = SIMD3(d4.x, d4.y, d4.z)
            // Reject by the mesh's box first.
            let b = me.visualBounds(relativeTo: me)
            if !Self.rayHitsBox(o, d, b.min, b.max) { continue }
            var k = 0
            while k + 2 < prim.indices.count {
                let a = prim.positions[Int(prim.indices[k])], bb = prim.positions[Int(prim.indices[k + 1])], c = prim.positions[Int(prim.indices[k + 2])]
                k += 3
                guard let t = Self.intersect(o, d, a, bb, c) else { continue }
                let local = o + t * d
                let world4 = w * SIMD4(local, 1)
                let world = SIMD3(world4.x, world4.y, world4.z)
                let dist = length(world - r.origin)
                if best == nil || dist < best!.t { best = (dist, name, world) }
            }
        }
        return best.map { ($0.name, $0.hit) }
    }

    private static func under(_ e: Entity, _ ancestor: Entity) -> Bool {
        var x: Entity? = e
        while let cur = x {
            if cur === ancestor { return true }
            x = cur.parent
        }
        return false
    }

    private func owner(_ e: Entity) -> String? {
        var x: Entity? = e
        while let cur = x {
            if !cur.name.isEmpty, parts[cur.name] === cur { return cur.name }
            x = cur.parent
        }
        return nil
    }

    private static func rayHitsBox(_ o: SIMD3<Float>, _ d: SIMD3<Float>, _ lo: SIMD3<Float>, _ hi: SIMD3<Float>) -> Bool {
        var tmin: Float = -.infinity, tmax: Float = .infinity
        for i in 0 ..< 3 {
            if abs(d[i]) < 1e-12 {
                if o[i] < lo[i] - 1e-6 || o[i] > hi[i] + 1e-6 { return false }
            } else {
                var t1 = (lo[i] - o[i]) / d[i], t2 = (hi[i] - o[i]) / d[i]
                if t1 > t2 { swap(&t1, &t2) }
                tmin = max(tmin, t1); tmax = min(tmax, t2)
            }
        }
        return tmax >= max(tmin, 0)
    }

    /// Möller–Trumbore: the distance along the ray to the triangle, if it hits.
    private static func intersect(_ o: SIMD3<Float>, _ d: SIMD3<Float>, _ a: SIMD3<Float>, _ b: SIMD3<Float>, _ c: SIMD3<Float>) -> Float? {
        let e1 = b - a, e2 = c - a
        let p = cross(d, e2)
        let det = dot(e1, p)
        if abs(det) < 1e-12 { return nil }
        let inv = 1 / det
        let s = o - a
        let u = dot(s, p) * inv
        if u < 0 || u > 1 { return nil }
        let q = cross(s, e1)
        let v = dot(d, q) * inv
        if v < 0 || u + v > 1 { return nil }
        let t = dot(e2, q) * inv
        return t > 0 ? t : nil
    }

    // MARK: Dragging a part

    /// A long press landed: if it is on a part, that part follows the finger. Returns its name.
    public func beginDrag(at p: CGPoint) -> String? {
        guard let (name, hit) = part(at: p), let e = parts[name] else { return nil }
        let m = camera.transformMatrix(relativeTo: nil)
        let forward = -SIMD3(m.columns.2.x, m.columns.2.y, m.columns.2.z)
        drag = (name, normalize(forward), hit, e.position)
        for (me, prim) in meshes where Self.under(me, e) {
            me.model?.materials = [GLB.material(prim, highlight: UIColor(red: 0, green: 0.56, blue: 1, alpha: 1))]
        }
        return name
    }

    public func drag(to p: CGPoint) {
        guard let d = drag, let e = parts[d.name], let r = ray(p) else { return }
        let denom = dot(r.direction, d.normal)
        guard abs(denom) > 1e-6 else { return }
        let t = dot(d.hit - r.origin, d.normal) / denom
        guard t > 0 else { return }
        let w = r.origin + t * r.direction
        let parent = e.parent
        let a = parent?.convert(position: d.hit, from: nil) ?? d.hit
        let b = parent?.convert(position: w, from: nil) ?? w
        e.position = d.start + (b - a)
    }

    /// The finger lifted: the part's new place as a state patch (`"part:<name>"`), or nil.
    public func endDrag() -> (key: String, value: [String: Any])? {
        guard let d = drag, let e = parts[d.name] else { return nil }
        drag = nil
        let p = e.position
        let base = agentPosition(d.name)
        let from = base ?? original[ObjectIdentifier(e)]?.translation ?? .zero
        let r = { (x: Float) in (Double(x) * 1e5).rounded() / 1e5 }
        let moved = p - from
        guard length(d.start - p) > 1e-6 else {
            apply()
            return nil
        }
        let value: [String: Any] = [
            "position": [r(p.x), r(p.y), r(p.z)],
            "moved_by": [r(moved.x), r(moved.y), r(moved.z)],
            "base": (((params["parts"] as? [String: Any])?[d.name] as? [String: Any])?["position"]) ?? NSNull(),
        ]
        // Kept here at once (and restores the colors the drag tinted), before the save comes back.
        state["part:\(d.name)"] = value
        apply()
        refreshSnapshot()
        return ("part:\(d.name)", value)
    }

    public func cancelDrag() {
        guard let d = drag, let e = parts[d.name] else { return }
        e.position = d.start
        drag = nil
        apply()
    }

    // MARK: Anchors

    /// What a Mark drawn over the model points at: the parts its points enclose (a closed loop)
    /// or cover (a line or arrow), most covered first, with the camera as it was. `points` and
    /// `bounds` are in the view's points.
    public func resolve(points: [CGPoint], bounds: CGRect) -> [String: Any]? {
        guard model != nil, !points.isEmpty else { return nil }
        let first = points[0], last = points[points.count - 1]
        let closed = points.count > 8 && hypot(first.x - last.x, first.y - last.y) < 0.35 * hypot(bounds.width, bounds.height)
        var samples: [CGPoint] = []
        if closed {
            let step = max(2, sqrt(bounds.width * bounds.height / 150))
            var y = bounds.minY
            while y <= bounds.maxY {
                var x = bounds.minX
                while x <= bounds.maxX {
                    if Self.inside(CGPoint(x: x, y: y), points) { samples.append(CGPoint(x: x, y: y)) }
                    x += step
                }
                y += step
            }
        }
        if samples.isEmpty {
            let every = max(1, points.count / 80)
            samples = points.enumerated().filter { $0.offset % every == 0 }.map(\.element)
        }
        var count: [String: Int] = [:]
        for s in samples { if let (name, _) = part(at: s) { count[name, default: 0] += 1 } }
        let cam = pose
        if count.isEmpty {
            return ["kind": "local", "bounds": [bounds.minX, bounds.minY, bounds.width, bounds.height].map { Int($0.rounded()) }, "label": "the model, away from its parts", "camera": cam]
        }
        let total = count.values.reduce(0, +)
        let ranked = count.sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }
            .enumerated().filter { $0.offset == 0 || Double($0.element.value) / Double(total) >= 0.08 }.map(\.element.key)
        let label = ranked.count == 1 ? "part \(ranked[0])" : "parts \(ranked.prefix(4).joined(separator: ", "))\(ranked.count > 4 ? ", …" : "")"
        return ["kind": "part", "part": ranked[0], "parts": Array(ranked.prefix(100)), "label": String(label.prefix(200)), "camera": cam]
    }

    private static func inside(_ p: CGPoint, _ poly: [CGPoint]) -> Bool {
        var c = false
        var j = poly.count - 1
        for i in poly.indices {
            let a = poly[i], b = poly[j]
            if (a.y > p.y) != (b.y > p.y), p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x { c.toggle() }
            j = i
        }
        return c
    }

    // MARK: Snapshot

    private func refreshSnapshot() {
        snapTask?.cancel()
        snapTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(250))
            guard let self, !Task.isCancelled else { return }
            self.view.snapshot(saveToHDR: false) { image in
                Task { @MainActor [weak self] in if let image { self?.snapshot = image } }
            }
        }
    }
}
