import OSLog
import PencilKit
import ReflexEmbed
import ReflexInput
import ReflexLink
import ReflexModel
import ReflexRender
import SwiftUI
import UniformTypeIdentifiers

private let log = Logger(subsystem: "si.eilmer.reflex", category: "space")

/// One open Space: its Ink canvas, its scene from the kernel, and the bridge
/// between the two. Every finished Ink change becomes a user intent in the
/// kernel, and undo and redo become the kernel's per-person undo. It also
/// fires the scene's Behaviors, opens their Panels, imports files, and makes
/// the Sends.
@MainActor @Observable
final class SpaceSession {
    let id: String
    let ink: InkCanvasController
    private(set) var scene = SceneDocument(space: nil, elements: [])
    /// Ink from other devices, by stroke ID: its raw points.
    private(set) var remoteInk: [String: [[Double]]] = [:]
    /// Every Agent batch and person's action, oldest first.
    private(set) var timeline: [[String: Any]] = []
    /// An Element the person is dragging, and how far.
    private(set) var dragging: (id: String, by: CGSize)?
    /// The Panel a Behavior opened, and the Element it belongs to.
    var panel: (element: String, panel: Panel)?
    /// What each Panel holds now: element ID -> component ID -> value.
    private(set) var panelValues: [String: [String: JSONValue]] = [:]
    /// Something to tell the person, shown briefly.
    var notice: String?
    /// The Space's live HTML Embeds, on the canvas and in Panels.
    let embeds = EmbedHost()
    /// The Space's 3D Embeds.
    let models = ModelHost()

    @ObservationIgnored private let link: LinkSync
    /// Kernel history entries made by each canvas action, so one canvas undo undoes all of them.
    @ObservationIgnored private var done: [Int] = []
    @ObservationIgnored private var undone: [Int] = []
    @ObservationIgnored private var sending: Task<Void, Never>?
    @ObservationIgnored private var seen = -1
    /// Panel values entered since the last Send, by Element.
    /// Strokes drawn inside an Element with an `ink_inside` Behavior, waiting for the person to pause.
    @ObservationIgnored private var inkInside: [String: [String]] = [:]
    @ObservationIgnored private var inkInsideTimer: Task<Void, Never>?
    @ObservationIgnored private var panelTimer: Task<Void, Never>?
    @ObservationIgnored private var hintsTimer: Task<Void, Never>?
    @ObservationIgnored private var refusedAt = Date.distantPast
    @ObservationIgnored private var seenLibrary = -1
    /// Embed state saved since the last write, by Element, written once the Embed pauses.
    @ObservationIgnored private var statePatches: [String: [String: Any]] = [:]
    @ObservationIgnored private var stateTimer: Task<Void, Never>?
    /// Panel values entered here and not yet saved, by Element and component, so the scene doesn't overwrite them.
    @ObservationIgnored private var unsavedPanel: [String: Set<String>] = [:]
    /// How many times the Link made this Space start over here (it refused changes from this iPad).
    @ObservationIgnored private var seenResets = 0
    /// What each stroke drawn over a 3D Embed pointed at when it was drawn (with the camera then), by stroke ID.
    @ObservationIgnored private var modelAnchors: [String: (element: String, anchor: [String: Any])] = [:]
    /// The 3D Embed whose part the person is dragging, and the part.
    @ObservationIgnored private var grabbed: (element: String, part: String)?

    init(id: String, link: LinkSync) {
        self.id = id
        self.link = link
        ink = InkCanvasController(space: id)
        ink.onEdit = { [weak self] edit in self?.commit(edit) }
        ink.claimsTouch = { [weak self] kind, p in
            self?.element(at: p) { e in
                guard e.locked != true else { return false }
                switch kind {
                case .tap: return !e.behaviors(on: "tap").isEmpty
                case .longPress: return !e.behaviors(on: "long_press").isEmpty
                case .drag: return e.draggable == true
                }
            } != nil
        }
        ink.onTap = { [weak self] p in self?.touched(p, trigger: "tap") }
        ink.onLongPress = { [weak self] p in self?.touched(p, trigger: "long_press") }
        ink.onDrag = { [weak self] start, by, ended in self?.drag(from: start, by: by, ended: ended) }
        ink.refusesInk = { [weak self] p in self?.noInk(at: p) ?? false }
        ink.onRefused = { [weak self] in self?.refusedInk() }
        ink.onPen = { [weak self] down in
            guard let self else { return }
            self.link.reportPresence(space: self.id, pen: down)
        }
        embeds.onEvent = { [weak self] key, event in self?.embedEvent(key, event) }
        // Where the pen or finger is, for the other people in a shared Space.
        ink.onCursor = { [weak self] p in self?.link.reportCursor(p) }
        seenResets = link.resets[id] ?? 0
        models.bytes = { [link] hash in link.asset(hash) }
        ink.surfaceAt = { [weak self] p in self?.modelEmbed(at: p) != nil }
        ink.onSurface = { [weak self] g in self?.surface(g) }
        refresh()
    }

    /// This person's role here: "owner", "editor", "viewer", or nil once the owner removed them.
    var role: String? { link.role(id) }
    var share: ShareInfo? { link.shares[id] }

    /// Reads the scene again when the Space changed, here or on the Link.
    func refresh() {
        if let lib = link.library, lib.revision != seenLibrary {
            seenLibrary = lib.revision
            embeds.templates = Dictionary(link.embedTemplates().map { ($0.name, EmbedHost.Template(html: $0.html, allow: $0.allow, source: $0.source)) }) { a, _ in a }
        }
        let r = link.revision[id] ?? 0
        // A viewer, or someone the owner removed, can't draw or erase here.
        ink.readOnly = role == "viewer" || role == nil
        guard r != seen, let json = link.scene(id) else { return }
        seen = r
        do {
            scene = try SceneDocument.decode(json)
        } catch {
            log.error("Could not read the scene of \(self.id, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }
        // The Link refused this iPad's changes and the Space started over: take back the strokes it didn't keep.
        if let n = link.resets[id], n != seenResets {
            seenResets = n
            let kept = Set(scene.elements.map(\.id))
            ink.withdraw(ink.strokes.map(\.id).filter { !kept.contains($0) })
            say(role == "viewer" ? "Your stroke wasn't kept: \(share?.owner.name ?? "the owner") made you a viewer here." : "Your changes weren't kept: you're no longer in this Space.")
        }
        // Ink this canvas didn't draw came from another device: draw it from its raw points.
        let local = Set(ink.strokes.map(\.id))
        let other = scene.elements.filter { $0.type == "ink" && !local.contains($0.id) }.map(\.id)
        let missing = other.filter { remoteInk[$0] == nil }
        var next = remoteInk.filter { other.contains($0.key) }
        if !missing.isEmpty { next.merge(link.strokes(id, ids: missing)) { a, _ in a } }
        if next.keys.sorted() != remoteInk.keys.sorted() { remoteInk = next }
        timeline = link.timeline(id)
        // Panel values saved on any device (the Element's `values`), except what is being entered here.
        for e in scene.elements {
            guard let saved = e.values?.object else { continue }
            for (_, panelValues) in saved {
                for (k, v) in panelValues.object ?? [:] where !(unsavedPanel[e.id]?.contains(k) ?? false) {
                    self.panelValues[e.id, default: [:]][k] = v
                }
            }
        }
        var live = Set(scene.elements.filter { $0.type == "embed" }.map(\.id))
        if let (eid, p) = panel {
            for c in p.components where c.kind == "embed" { live.insert(Self.panelKey(eid, c)) }
        }
        embeds.keep(live)
        models.keep(Set(scene.elements.filter { $0.type == "embed" && $0.model != nil }.map(\.id)))
    }

    var localInk: Set<String> { Set(ink.strokes.map(\.id)) }

    // MARK: Ink

    private func commit(_ edit: InkEdit) {
        switch edit {
        case .action(let intents):
            var entries = 0
            var refused: [String] = []
            for intent in intents {
                let r = link.intent(id, Self.json(intent))
                if r?["entry"] is String { entries += 1 }
                // Ink where a Region has `ink: false` is refused by the kernel; take it back off the canvas.
                if case .add(let s) = intent, r?["ok"] as? Bool == false { refused.append(s.id) }
            }
            if !refused.isEmpty {
                ink.withdraw(refused)
                refusedInk()
            }
            if entries > 0 {
                done.append(entries)
                undone = []
            }
            for case .add(let stroke) in intents where !refused.contains(stroke.id) {
                drewInside(stroke)
                markModel(stroke)
            }
        case .undo:
            guard let n = done.popLast() else { return }
            for _ in 0 ..< n { link.undo(id) }
            undone.append(n)
        case .redo:
            guard let n = undone.popLast() else { return }
            for _ in 0 ..< n { link.redo(id) }
            done.append(n)
        }
        refresh()
        readWatchedRegions()
    }

    /// One action that isn't Ink, made undoable from the same toolbar and gestures.
    @discardableResult
    private func act(_ intent: [String: Any]) -> [String: Any]? {
        record(link.intent(id, intent))
    }

    /// Puts a kernel result that made a history entry on the undo stack, or says why it was refused.
    @discardableResult
    private func record(_ r: [String: Any]?) -> [String: Any]? {
        if r?["entry"] is String {
            undone = []
            ink.recordAction(
                undo: { [weak self] in guard let self else { return }; self.link.undo(self.id); self.refresh() },
                redo: { [weak self] in guard let self else { return }; self.link.redo(self.id); self.refresh() }
            )
        } else if r?["ok"] as? Bool == false {
            let msg = (r?["errors"] as? [[String: Any]])?.first?["msg"] as? String ?? "It was refused."
            say("Couldn't do that: \(msg)")
        }
        refresh()
        return r
    }

    private static func stroke(_ s: PortableStroke) -> [String: Any] {
        let width = s.points.first.map { max(1, min(40, $0.width)) } ?? 3
        return ["id": s.id, "stroke": ["points": s.spacePoints], "tool": "pen", "color": s.namedColor, "width": width]
    }

    static func json(_ intent: InkIntent) -> [String: Any] {
        switch intent {
        case .add(let s):
            return stroke(s).merging(["intent": "add_stroke"]) { a, _ in a }
        case .erase(let ids):
            return ["intent": "erase", "ids": ids]
        case .cut(let target, let fragments):
            return ["intent": "erase_precise", "id": target, "fragments": fragments.map(stroke)]
        case .move(let ids, let dx, let dy):
            return ["intent": "move", "ids": ids, "by": [dx, dy]]
        }
    }

    // MARK: Agents

    /// The Agents that changed this Space, in the order they first did.
    var agentsHere: [String] {
        var out: [String] = []
        for e in timeline {
            if let a = (e["by"] as? [String: Any])?["agent"] as? String, !out.contains(a) { out.append(a) }
        }
        return out
    }

    /// The Agent's latest change that isn't reverted, if any.
    func lastChange(of agent: String) -> [String: Any]? {
        timeline.last { ($0["by"] as? [String: Any])?["agent"] as? String == agent && $0["kind"] as? String == "batch" && $0["state"] as? String != "reverted"
            && (($0["counts"] as? [String: Int])?.values.contains { $0 > 0 } ?? true) }
    }

    /// Reverts the Agent's latest change, as the person's own action (undo brings it back).
    func revert(_ agent: String, name: String) {
        guard let r = record(link.revert(id, agent: agent)), r["ok"] as? Bool == true else { return }
        let kept = (r["kept"] as? [Any])?.count ?? 0
        say("Reverted \(AgentsBar.short(name))'s last change" + (kept > 0 ? "; \(kept) field\(kept == 1 ? "" : "s") you changed since stayed" : ""))
    }

    // MARK: Behaviors

    /// The topmost Element at a Space point that passes `test`.
    func element(at p: CGPoint, where test: (SceneElement) -> Bool) -> SceneElement? {
        scene.elements.reversed().first { e in
            guard e.type != "ink", e.type != "connector", let f = e.frame else { return false }
            return f.contains(p) && test(e)
        }
    }

    private func touched(_ p: CGPoint, trigger: String) {
        // What the person picked shows on the other people's screens.
        link.reportCursor(p, selection: element(at: p, where: { _ in true }).map { [$0.id] } ?? [])
        guard let e = element(at: p, where: { !$0.behaviors(on: trigger).isEmpty }) else { return }
        fire(e, on: trigger)
    }

    private func drag(from start: CGPoint, by: CGSize, ended: Bool) {
        guard let e = element(at: start, where: { $0.draggable == true && $0.locked != true }) else { return }
        link.reportCursor(CGPoint(x: start.x + by.width, y: start.y + by.height), selection: [e.id])
        guard ended else {
            dragging = (e.id, by)
            return
        }
        dragging = nil
        let landed = snapped(e, by: by)
        let dx = Int(landed.width.rounded()), dy = Int(landed.height.rounded())
        guard dx != 0 || dy != 0 else { return }
        act(["intent": "move", "ids": [e.id], "by": [dx, dy]])
        fire(e, on: "drag_end")
    }

    /// Where a drag of `e` by `by` lands under its snap rules. With `to`, it drops into the
    /// nearest of those Elements (the one under its center, else the closest), centered
    /// across it and kept inside it; `grid` then rounds its top to steps measured from that
    /// Element's top. With only `grid`, its corner rounds to multiples of the step.
    func snapped(_ e: SceneElement, by: CGSize) -> CGSize {
        guard let f = e.frame, case .object(let rule)? = e.snap else { return by }
        let grid: Double? = { if case .number(let g)? = rule["grid"], g >= 1 { return g }; return nil }()
        let ids: [String] = { if case .array(let a)? = rule["to"] { return a.compactMap { if case .string(let s) = $0 { s } else { nil } } }; return [] }()
        var o = CGPoint(x: f.minX + by.width, y: f.minY + by.height)
        let center = CGPoint(x: o.x + f.width / 2, y: o.y + f.height / 2)
        let targets = scene.elements.filter { ids.contains($0.id) }.compactMap(\.frame)
        if let t = targets.first(where: { $0.contains(center) }) ?? targets.min(by: { hypot($0.midX - center.x, $0.midY - center.y) < hypot($1.midX - center.x, $1.midY - center.y) }) {
            o.x = t.minX + max(0, (t.width - f.width) / 2)
            if let g = grid { o.y = t.minY + ((o.y - t.minY) / g).rounded() * g }
            o.y = min(max(o.y, t.minY), max(t.minY, t.maxY - f.height))
        } else if let g = grid {
            o = CGPoint(x: (o.x / g).rounded() * g, y: (o.y / g).rounded() * g)
        }
        return CGSize(width: o.x - f.minX, height: o.y - f.minY)
    }

    /// A finished stroke inside an Element with an `ink_inside` Behavior fires it
    /// once the person pauses, with every stroke drawn inside meanwhile.
    private func drewInside(_ s: PortableStroke) {
        let b = s.bounds
        guard b.count == 4 else { return }
        let r = CGRect(x: b[0], y: b[1], width: b[2], height: b[3])
        let center = CGPoint(x: r.midX, y: r.midY)
        guard let e = element(at: center, where: { el in
            !el.behaviors(on: "ink_inside").isEmpty && (el.frame?.insetBy(dx: -8, dy: -8).contains(r) ?? false)
        }) else { return }
        inkInside[e.id, default: []].append(s.id)
        inkInsideTimer?.cancel()
        inkInsideTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1.5))
            guard !Task.isCancelled, let self else { return }
            let pending = self.inkInside
            self.inkInside = [:]
            for (eid, strokes) in pending {
                if let el = self.scene.elements.first(where: { $0.id == eid }) { self.fire(el, on: "ink_inside", strokes: strokes) }
            }
        }
    }

    /// Fires this Element's Behaviors for one trigger. The iPad opens Panels itself;
    /// everything else goes to the kernel as a raw Send naming the Element and the
    /// trigger, and the kernel decides what it is: a full Send (`send`), a tap that
    /// claims nothing (`notify`), or an action the Link runs (`set`, `apply_recipe`).
    func fire(_ e: SceneElement, on trigger: String, event: String? = nil, payload: [String: Any]? = nil, panel: String? = nil, values: [String: Any]? = nil, strokes: [String] = []) {
        let behaviors = e.behaviors(on: trigger).map(\.1).filter { trigger != "embed_event" || $0.event == event }
        guard !behaviors.isEmpty else { return }
        log.info("Behavior \(trigger, privacy: .public) on \(e.id, privacy: .public): \(behaviors.map(\.action), privacy: .public)")
        for b in behaviors where b.action == "open_panel" {
            if let p = b.panel { openPanel(p, on: e) }
        }
        guard behaviors.contains(where: { $0.action != "open_panel" }) else { return }
        var fired: [String: Any] = ["element": e.id, "on": trigger]
        if let event { fired["event"] = event }
        if let payload, !payload.isEmpty { fired["payload"] = payload }
        if let panel { fired["panel"] = panel }
        if let values { fired["values"] = values }
        if behaviors.contains(where: { $0.action == "send" }) {
            send(trigger: "behavior", extra: fired)
        } else {
            var raw = fired
            raw["send"] = Self.newSendID()
            raw["trigger"] = "behavior"
            raw["viewport"] = Self.ints(viewport())
            if !strokes.isEmpty { raw["strokes"] = strokes }
            do {
                let frozen = try link.freezeSend(id, raw: raw)
                #if DEBUG
                if let data = try? JSONSerialization.data(withJSONObject: frozen, options: [.sortedKeys]) {
                    log.info("Frozen Send: \(String(decoding: data, as: UTF8.self), privacy: .public)")
                }
                #endif
                if frozen["kind"] as? String == "tap" { say("Told the Agent") }
            } catch {
                say("Couldn't do that: \(error.localizedDescription)")
            }
        }
    }

    private func openPanel(_ p: Panel, on e: SceneElement) {
        var values = panelValues[e.id] ?? [:]
        for c in p.components {
            if let key = c.key, values[key] == nil, let v = c.value { values[key] = v }
        }
        panelValues[e.id] = values
        panel = (e.id, p)
    }

    /// The person changed a Panel value: it fires the Element's `panel_change`
    /// Behaviors, with every value, once they pause.
    func setPanelValue(_ value: JSONValue, for key: String) {
        guard let (eid, p) = panel else { return }
        panelValues[eid, default: [:]][key] = value
        unsavedPanel[eid, default: []].insert(key)
        panelTimer?.cancel()
        panelTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(0.8))
            guard !Task.isCancelled, let self else { return }
            self.savePanel(eid, p)
            self.panelChanged(eid, p)
        }
    }

    /// Saves the values entered in a Panel on its Element (`set_state` with the Panel's ID):
    /// they sync to the person's other devices, survive a reload and go with the next Send.
    private func savePanel(_ eid: String, _ p: Panel) {
        guard let keys = unsavedPanel.removeValue(forKey: eid), !keys.isEmpty else { return }
        let values = (panelValues[eid] ?? [:]).filter { keys.contains($0.key) }.mapValues(\.any)
        let r = link.intent(id, ["intent": "set_state", "id": eid, "panel": p.id ?? "panel", "values": values])
        if r?["ok"] as? Bool == false { say("Couldn't save the Panel: \((r?["errors"] as? [[String: Any]])?.first?["msg"] as? String ?? "it was refused")") }
    }

    /// A Panel button counts as a value (`true` under its ID) and fires `panel_change` now.
    func panelButton(_ c: Panel.Component) {
        guard let (eid, p) = panel, let key = c.key else { return }
        panelTimer?.cancel()
        panelValues[eid, default: [:]][key] = .bool(true)
        panelChanged(eid, p)
        panelValues[eid]?[key] = nil
    }

    private func panelChanged(_ eid: String, _ p: Panel) {
        guard let el = scene.elements.first(where: { $0.id == eid }) else { return }
        // Without a panel_change Behavior the values still go with the next Send.
        guard !el.behaviors(on: "panel_change").isEmpty else { return }
        fire(el, on: "panel_change", panel: p.id, values: (panelValues[eid] ?? [:]).mapValues(\.any))
    }

    func panelValue(_ key: String?) -> JSONValue? {
        guard let key, let (eid, _) = panel else { return nil }
        return panelValues[eid]?[key]
    }

    // MARK: Embeds

    /// An Embed in a Panel is keyed by its Element and component.
    static func panelKey(_ element: String, _ c: Panel.Component) -> String { "panel|\(element)|\(c.id)" }

    /// What an Embed did through its bridge. Its state is saved on its Element (an
    /// Embed in a Panel saves it as its component's value); `notify` becomes a tap for
    /// the Agent; `emit` fires the Element's `embed_event` Behaviors.
    private func embedEvent(_ key: String, _ event: EmbedHost.Event) {
        let parts = key.split(separator: "|", maxSplits: 2).map(String.init)
        let inPanel = parts.count == 3 && parts[0] == "panel"
        let eid = inPanel ? parts[1] : key
        guard let el = scene.elements.first(where: { $0.id == eid }) else { return }
        switch event {
        case .setState(let patch):
            if inPanel {
                guard let (open, _) = panel, open == eid else { return }
                var state = panelValues[eid]?[parts[2]]?.object ?? [:]
                for (k, v) in patch { state[k] = v is NSNull ? nil : JSONValue(any: v) }
                setPanelValue(.object(state), for: parts[2])
            } else {
                statePatches[eid, default: [:]].merge(patch) { _, b in b }
                stateTimer?.cancel()
                stateTimer = Task { [weak self] in
                    try? await Task.sleep(for: .seconds(0.3))
                    guard !Task.isCancelled else { return }
                    self?.saveEmbedState()
                }
            }
        case .notify(let payload):
            notify(el, payload)
        case .toolCall(let server, let name, let arguments):
            notify(el, ["tool_call": ["server": server, "name": name, "arguments": arguments]])
        case .message(let message):
            notify(el, ["message": message])
        case .emit(let name, let payload):
            if el.behaviors(on: "embed_event").contains(where: { $0.behavior.event == name }) {
                fire(el, on: "embed_event", event: name, payload: payload)
            } else {
                log.info("Embed \(eid, privacy: .public) emitted \(name, privacy: .public), which no Behavior takes")
            }
        case .panel(let spec):
            guard let data = try? JSONSerialization.data(withJSONObject: spec), let p = try? JSONDecoder().decode(Panel.self, from: data) else {
                say("The Embed's Panel couldn't be read")
                return
            }
            openPanel(p, on: el)
        }
    }

    private func saveEmbedState() {
        let pending = statePatches
        statePatches = [:]
        for (eid, patch) in pending {
            let r = link.intent(id, ["intent": "set_state", "id": eid, "state": patch])
            if r?["ok"] as? Bool == false { say("Couldn't save the Embed's state: \((r?["errors"] as? [[String: Any]])?.first?["msg"] as? String ?? "it was refused")") }
        }
    }

    /// An Embed's "notify agent" event: a tap for the Agent that placed it, which claims nothing.
    private func notify(_ el: SceneElement, _ payload: [String: Any]) {
        saveEmbedState()
        let raw: [String: Any] = ["send": Self.newSendID(), "trigger": "embed", "element": el.id, "payload": payload, "viewport": Self.ints(viewport())]
        do {
            _ = try link.freezeSend(id, raw: raw)
            say("Told the Agent")
        } catch {
            say("Couldn't tell the Agent: \(error.localizedDescription)")
        }
    }

    /// Asks each Embed a stroke was drawn on what the stroke points at, in the Embed's own pixels.
    private func embedAnchors(_ strokes: [String]) async -> [[String: Any]] {
        var out: [[String: Any]] = []
        // A 3D Embed answered when the stroke was drawn, with the camera as it was then.
        var answered = Set<String>()
        for s in strokes {
            guard let (eid, anchor) = modelAnchors[s] ?? resolveModel(s) else { continue }
            out.append(["element": eid, "strokes": [s], "anchor": anchor])
            answered.insert(s)
        }
        let strokes = strokes.filter { !answered.contains($0) }
        let frames = scene.elements.filter { $0.type == "embed" && $0.model == nil }.compactMap { e in e.frame.map { (e.id, $0) } }
        guard !frames.isEmpty, !strokes.isEmpty else { return out }
        let bounds = Dictionary(ink.strokes.map { ($0.id, $0.bounds) }) { a, _ in a }
        let points = link.strokes(id, ids: strokes)
        for s in strokes {
            guard let b = bounds[s], let pts = points[s] else { continue }
            for (eid, f) in frames where f.intersects(b) {
                let local = pts.map { [$0[0] - f.minX, $0[1] - f.minY] }
                let lb = [b.minX - f.minX, b.minY - f.minY, b.width, b.height].map { Double(($0 * 10).rounded() / 10) }
                if let anchor = await embeds.resolve(eid, points: local, bounds: lb) {
                    out.append(["element": eid, "strokes": [s], "anchor": anchor])
                }
            }
        }
        return out
    }

    // MARK: 3D Embeds

    /// The 3D Embed under a Space point, topmost first.
    private func modelEmbed(at p: CGPoint) -> SceneElement? {
        scene.elements.last { $0.type == "embed" && $0.model != nil && $0.frame?.contains(p) == true && $0.locked != true }
    }

    /// A finger gesture on a 3D Embed: turn, slide or zoom the view, or grab a part (a long press) and move it.
    private func surface(_ g: SurfaceGesture) {
        let start: CGPoint = switch g {
        case .orbit(let s, _), .slide(let s, _), .zoom(let s, _), .hold(let s, _, _), .ended(let s): s
        }
        guard let el = modelEmbed(at: start), let frame = el.frame, let model = models.existing(el.id) else { return }
        let local = { (p: CGPoint) in CGPoint(x: p.x - frame.minX, y: p.y - frame.minY) }
        switch g {
        case .orbit(_, let by):
            if grabbed == nil { model.orbit(by: by) }
        case .slide(_, let by):
            if grabbed == nil { model.pan(by: by) }
        case .zoom(_, let scale):
            if grabbed == nil { model.zoom(by: scale) }
        case .hold(_, let at, let phase):
            switch phase {
            case .began:
                // Moving a part changes the Space, which a viewer can't do.
                if ink.readOnly { return refusedInk() }
                if let part = model.beginDrag(at: local(at)) { grabbed = (el.id, part) }
            case .changed:
                if grabbed?.element == el.id { model.drag(to: local(at)) }
            case .ended:
                guard let g = grabbed, g.element == el.id else { return }
                grabbed = nil
                if let (key, value) = model.endDrag() {
                    // Saved like any Embed state: it syncs, survives reloads and shows in the next Send.
                    statePatches[el.id, default: [:]][key] = value
                    saveEmbedState()
                    say("Moved \(g.part)")
                }
            case .cancelled:
                if grabbed?.element == el.id { model.cancelDrag() }
                grabbed = nil
            }
        case .ended:
            model.interactionEnded()
        }
    }

    /// A stroke drawn over a 3D Embed: ask it now what the stroke points at, while the camera is as the person sees it.
    private func markModel(_ stroke: PortableStroke) {
        if let r = resolveModel(stroke.id, points: stroke.spacePoints) { modelAnchors[stroke.id] = r }
    }

    private func resolveModel(_ strokeID: String, points: [[Double]]? = nil) -> (element: String, anchor: [String: Any])? {
        guard let pts = points ?? link.strokes(id, ids: [strokeID])[strokeID], !pts.isEmpty else { return nil }
        let xs = pts.map { $0[0] }, ys = pts.map { $0[1] }
        let b = CGRect(x: xs.min()!, y: ys.min()!, width: xs.max()! - xs.min()!, height: ys.max()! - ys.min()!)
        guard let el = scene.elements.last(where: { $0.type == "embed" && $0.model != nil && ($0.frame?.intersects(b.insetBy(dx: -1, dy: -1)) ?? false) }),
              let f = el.frame, let model = models.existing(el.id) else { return nil }
        let local = pts.map { CGPoint(x: $0[0] - f.minX, y: $0[1] - f.minY) }
        guard let anchor = model.resolve(points: local, bounds: b.offsetBy(dx: -f.minX, dy: -f.minY)) else { return nil }
        return (el.id, anchor)
    }

    /// Pictures of the 3D Embeds on screen, for Send crops: a view snapshot doesn't hold their Metal content.
    var modelSnapshots: [(CGRect, UIImage)] {
        scene.elements.compactMap { e in
            guard e.type == "embed", e.model != nil, let f = e.frame, let img = models.existing(e.id)?.snapshot else { return nil }
            return (f, img)
        }
    }

    // MARK: Regions

    var regions: [SceneElement] { scene.elements.filter { $0.type == "region" && $0.frame != nil } }

    /// Whether `b` lies in the Region: its center is inside, as the kernel decides.
    private static func inside(_ r: CGRect, _ b: CGRect) -> Bool { r.contains(CGPoint(x: b.midX, y: b.midY)) }

    private func noInk(at p: CGPoint) -> Bool {
        regions.contains { $0.ink == false && $0.frame!.contains(p) }
    }

    private func refusedInk() {
        guard Date().timeIntervalSince(refusedAt) > 2 else { return }
        refusedAt = Date()
        if role == "viewer" { return say("You can view this Space: \(share?.owner.name ?? "its owner") made you a viewer.") }
        if role == nil { return say("\(share?.owner.name ?? "The owner") removed you from this Space.") }
        say("Writing isn't allowed in this area")
    }

    /// This iPad's strokes in a Region.
    private func strokes(in r: SceneElement) -> [String] {
        guard let f = r.frame else { return [] }
        return ink.strokes.filter { Self.inside(f, $0.bounds) }.map(\.id)
    }

    /// Reads the person's handwriting in each watched Region once they pause, and
    /// hands the lines to the Link, so its watch snapshots carry the recognizer's text.
    private func readWatchedRegions() {
        let watched = regions.filter { $0.watch == true }
        guard !watched.isEmpty else { return }
        hintsTimer?.cancel()
        hintsTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(0.8))
            guard !Task.isCancelled, let self else { return }
            for r in watched {
                let hints = await Handwriting.lineHints(self.ink.pkStrokes(self.strokes(in: r)))
                guard !Task.isCancelled else { return }
                self.link.reportHints(space: self.id, region: r.id, hints: hints)
                log.info("Watch hints for \(r.id, privacy: .public): \(hints.compactMap { $0["text"] as? String }, privacy: .public)")
            }
        }
    }

    /// A Region's own Send button ("Check my work"): only the work inside it, with the
    /// recognizer's text for each line of it, and a crop of the whole Region.
    func sendRegion(_ r: SceneElement) {
        guard let frame = r.frame else { return }
        let all = strokes(in: r)
        let strokes = ink.takeUnsent(among: Set(all))
        let view = viewport()
        let zoom = ink.zoomScale, offset = ink.contentOffset
        var raw: [String: Any] = ["send": Self.newSendID(), "trigger": "region", "region": r.id, "viewport": Self.ints(view)]
        if let crop = Crop.capture(space: frame.insetBy(dx: -8, dy: -8).intersection(view), zoom: zoom, offset: offset) {
            do {
                let hash = try link.storeAsset(crop.png)
                raw["crops"] = [["asset": hash, "bounds": Self.ints(crop.bounds), "strokes": strokes]]
            } catch {
                log.error("Could not store the crop: \(error.localizedDescription, privacy: .public)")
            }
        }
        let pk = ink.pkStrokes(all)
        saveEmbedState()
        let previous = sending
        sending = Task {
            await previous?.value
            let hints = await Handwriting.lineHints(pk)
            if !hints.isEmpty { raw["hints"] = hints }
            // Embeds in the Region (a practice box, a table) say what each stroke is on.
            let anchors = await embedAnchors(strokes)
            if !anchors.isEmpty { raw["embed_anchors"] = anchors }
            freeze(raw)
        }
    }

    #if DEBUG
    /// Writes `text` by hand with its baseline starting at a screen point.
    func debugWrite(screen at: CGPoint, text: String, size: CGFloat, pause: Double = 0.05) async {
        let zoom = ink.zoomScale, offset = ink.contentOffset
        let origin = CGPoint(x: (at.x + offset.x) / zoom, y: (at.y + offset.y) / zoom)
        for stroke in DebugHand.strokes(text, at: origin, size: size / zoom) {
            ink.debugDraw(space: stroke)
            try? await Task.sleep(for: .seconds(pause))
        }
    }

    /// Draws one pen stroke through screen points, with points 4 pt apart along each segment as a pen moves.
    func debugLine(screen corners: [CGPoint]) {
        var points: [CGPoint] = corners.first.map { [$0] } ?? []
        for (a, b) in zip(corners, corners.dropFirst()) {
            let n = max(1, Int(hypot(b.x - a.x, b.y - a.y) / 4))
            for i in 1 ... n {
                let t = CGFloat(i) / CGFloat(n)
                points.append(CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t))
            }
        }
        ink.debugDraw(screen: points)
    }

    /// Writes one line of text by hand in a Region, below the person's lines there,
    /// as simulated Pencil strokes (the Simulator has no Pencil): each glyph's outline
    /// becomes strokes, drawn one after another with the pen going down and up.
    func debugWrite(region: String, text: String, size: CGFloat = 30, pause: Double = 0.05) async {
        guard let r = regions.first(where: { $0.id == region || $0.id.hasSuffix(":\(region)") }), let f = r.frame else {
            say("No Region '\(region)'")
            return
        }
        let mine = ink.strokes.filter { Self.inside(f, $0.bounds) }.map(\.bounds)
        let baseline = (mine.map(\.maxY).max().map { $0 + size * 0.6 } ?? f.minY + 48) + size
        guard baseline + 10 < f.maxY else {
            say("Region '\(region)' is full")
            return
        }
        for stroke in DebugHand.strokes(text, at: CGPoint(x: f.minX + 40, y: baseline), size: size) {
            ink.debugDraw(space: stroke)
            try? await Task.sleep(for: .seconds(pause))
        }
    }
    #endif

    // MARK: Sending

    private func viewport() -> CGRect {
        let zoom = ink.zoomScale, offset = ink.contentOffset
        let screen = ink.canvasView.bounds.size
        return CGRect(x: offset.x / zoom, y: offset.y / zoom, width: screen.width / zoom, height: screen.height / zoom)
    }

    private static func ints(_ r: CGRect) -> [Int] { [r.minX, r.minY, r.width, r.height].map { Int($0.rounded()) } }

    private static func newSendID() -> String {
        "s_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(12)
    }

    /// Captures a Send: the strokes since the last one (claimed by the kernel),
    /// when each was drawn, Apple's handwriting hint for each group that reads as
    /// writing, the voice transcript with word timings, the viewport, and a crop of
    /// what the screen showed around the strokes (stored as an asset first, so it
    /// is durable before the Send refers to it).
    func send(trigger: String, said: String? = nil, words: [[String: Any]] = [], extra: [String: Any] = [:]) {
        let strokes = ink.takeUnsent()
        if trigger == "voice", said?.isEmpty ?? true, strokes.isEmpty {
            say("Didn't hear anything, so nothing was sent.")
            return
        }
        let view = viewport()
        let zoom = ink.zoomScale, offset = ink.contentOffset
        var raw: [String: Any] = ["send": Self.newSendID(), "trigger": trigger, "viewport": Self.ints(view)]
        if let said, !said.isEmpty { raw["said"] = said }
        if !words.isEmpty { raw["words"] = words }
        raw.merge(extra) { a, _ in a }
        let marked = ink.strokes.filter { strokes.contains($0.id) }.map(\.bounds).reduce(CGRect.null) { $0.union($1) }
        if !marked.isNull, let crop = Crop.capture(space: marked.insetBy(dx: -60, dy: -60).intersection(view), zoom: zoom, offset: offset, models: modelSnapshots, ink: ink.canvasView.drawing) {
            do {
                let hash = try link.storeAsset(crop.png)
                raw["crops"] = [["asset": hash, "bounds": Self.ints(crop.bounds), "strokes": strokes]]
            } catch {
                log.error("Could not store the crop: \(error.localizedDescription, privacy: .public)")
            }
        }
        let pk = ink.pkStrokes(strokes)
        saveEmbedState()
        if let (eid, p) = panel { savePanel(eid, p) }
        // Sends freeze in the order they were made: the kernel claims every unsent
        // stroke, so a later Send must not freeze while this one reads handwriting.
        let previous = sending
        sending = Task {
            await previous?.value
            let hints = await Handwriting.hints(pk)
            if !hints.isEmpty { raw["hints"] = hints }
            let anchors = await embedAnchors(strokes)
            if !anchors.isEmpty { raw["embed_anchors"] = anchors }
            freeze(raw)
        }
    }

    private func freeze(_ raw: [String: Any]) {
        do {
            let frozen = try link.freezeSend(id, raw: raw)
            let n = (frozen["strokes"] as? [Any])?.count ?? 0
            let hints = (raw["hints"] as? [[String: Any]])?.compactMap { $0["text"] as? String } ?? []
            log.info("Send \(frozen["send"] as? String ?? "", privacy: .public) frozen with \(n) strokes, hints \(hints, privacy: .public), said \(raw["said"] as? String ?? "", privacy: .public)")
            #if DEBUG
            if let data = try? JSONSerialization.data(withJSONObject: frozen, options: [.sortedKeys]) {
                log.info("Frozen Send: \(String(decoding: data, as: UTF8.self), privacy: .public)")
            }
            #endif
            var what = "\(n) stroke\(n == 1 ? "" : "s")"
            if raw["said"] != nil { what += " and your voice" }
            if case .connected = link.state { say("Sent: \(what)") } else { say("Saved: it goes out when the Link is back") }
        } catch {
            say("Could not send: \(error.localizedDescription)")
        }
    }

    // MARK: Imports

    /// Where something new of `size` goes: the middle of the screen if that's
    /// free, else the nearest free spot on screen, else below everything.
    private func nextSpot(_ size: CGSize) -> CGPoint {
        let v = viewport()
        let taken = scene.elements.filter { !["ink", "connector"].contains($0.type) }.compactMap(\.frame).map { $0.insetBy(dx: -20, dy: -20) }
        let free = { (p: CGPoint) in !taken.contains { $0.intersects(CGRect(origin: p, size: size)) } }
        let center = CGPoint(x: v.midX - size.width / 2, y: v.midY - size.height / 2)
        var tries = [center]
        for ring in 1 ... 12 {
            let d = CGFloat(ring) * 60
            for i in 0 ..< ring * 8 {
                let a = Double(i) / Double(ring * 8) * 2 * .pi
                tries.append(CGPoint(x: center.x + d * cos(a), y: center.y + d * sin(a)))
            }
        }
        let onScreen = { (p: CGPoint) in v.contains(CGRect(origin: p, size: size)) }
        let spot = tries.first { onScreen($0) && free($0) }
            ?? CGPoint(x: taken.map(\.minX).min() ?? v.minX, y: (taken.map(\.maxY).max() ?? v.minY) + 20)
        return CGPoint(x: spot.x.rounded(), y: spot.y.rounded())
    }

    /// Scrolls so `space` (a rect in Space coordinates) is on screen.
    private func show(_ space: CGRect) {
        guard !viewport().contains(space) else { return }
        let z = ink.zoomScale
        ink.canvasView.scrollRectToVisible(CGRect(x: space.minX * z, y: space.minY * z, width: space.width * z, height: space.height * z).insetBy(dx: -40, dy: -40), animated: true)
    }

    private static func newID(_ prefix: String) -> String {
        prefix + "-" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(10)
    }

    /// A photo or camera capture becomes an image Element the person can write on.
    func importImage(_ data: Data, name: String) {
        guard let image = UIImage(data: data), let bytes = Imports.encode(image) else {
            say("Couldn't read that image")
            return
        }
        let size = Imports.fit(image.size, in: CGSize(width: 640, height: 640))
        addFile(name: name, mime: bytes.starts(with: [0x89, 0x50]) ? "image/png" : "image/jpeg", bytes: bytes, size: size)
    }

    /// A file from Files or a drop: each page of a PDF becomes an image Element,
    /// a picture an image Element, and anything else a file Element.
    func importFile(_ url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else {
            say("Couldn't open \(url.lastPathComponent)")
            return
        }
        importData(data, name: url.lastPathComponent, type: UTType(filenameExtension: url.pathExtension))
    }

    func importData(_ data: Data, name: String, type: UTType?) {
        if type?.conforms(to: .pdf) == true, let pages = Imports.pdfPages(data) {
            let size = pages.first.map { Imports.fit($0.size, in: CGSize(width: 600, height: 800)) } ?? .zero
            let cols = min(pages.count, 4), rows = (pages.count + 3) / 4
            let grid = CGSize(width: CGFloat(cols) * (size.width + 40) - 40, height: CGFloat(rows) * (size.height + 40) - 40)
            let start = nextSpot(grid)
            do {
                var rendered: [[String: Any]] = []
                for (i, page) in pages.enumerated() {
                    guard let bytes = Imports.encode(page) else { continue }
                    let hash = try link.storeAsset(bytes)
                    rendered.append(["id": Self.newID("pdf"), "src": "asset:\(hash)", "page": i + 1,
                                     "at": ["x": Int(start.x) + (i % 4) * Int(size.width + 40), "y": Int(start.y) + (i / 4) * Int(size.height + 40)],
                                     "w": Int(size.width), "h": Int(size.height)])
                }
                guard record(link.intent(id, ["intent": "add_file", "id": Self.newID("file"), "name": String(name.prefix(255)),
                                              "mime": "application/pdf", "size": data.count, "pages": rendered]))?["ok"] as? Bool != false else { return }
                show(CGRect(origin: start, size: grid))
                say("Added \(name): \(pages.count) page\(pages.count == 1 ? "" : "s")")
            } catch {
                say("Couldn't save \(name): \(error.localizedDescription)")
            }
        } else if let ext = name.split(separator: ".").last?.lowercased(), ["glb", "gltf", "usdz"].contains(ext) {
            // A 3D model becomes a 3D Embed (the kernel's add_file makes it one). A .gltf is packed into one .glb first.
            var bytes = data
            if ext == "gltf" {
                do { bytes = try Imports.packGLTF(data) } catch {
                    say("Couldn't add \(name): \(error.localizedDescription)")
                    return
                }
            }
            let mime = ext == "usdz" ? "model/vnd.usdz+zip" : "model/gltf-binary"
            addFile(name: ext == "gltf" ? String(name.dropLast(4)) + "glb" : name, mime: mime, bytes: bytes, size: CGSize(width: 560, height: 420))
        } else if type?.conforms(to: .image) == true, UIImage(data: data) != nil {
            importImage(data, name: name)
        } else {
            addFile(name: name, mime: type?.preferredMIMEType ?? "application/octet-stream", bytes: data, size: CGSize(width: 260, height: 64))
        }
    }

    /// Stores the bytes as an asset first, then adds the Element in the nearest free spot (`add_file`).
    private func addFile(name: String, mime: String, bytes: Data, size: CGSize) {
        do {
            let hash = try link.storeAsset(bytes)
            let spot = nextSpot(size)
            let r = act(["intent": "add_file", "id": Self.newID(mime.hasPrefix("image/") ? "img" : mime.hasPrefix("model/") ? "model" : "file"), "name": String(name.prefix(255)),
                         "mime": mime, "size": bytes.count, "src": "asset:\(hash)",
                         "at": ["x": Int(spot.x), "y": Int(spot.y)], "w": Int(size.width.rounded()), "h": Int(size.height.rounded())])
            if r?["ok"] as? Bool != false { show(CGRect(origin: spot, size: size)) }
        } catch {
            say("Couldn't save \(name): \(error.localizedDescription)")
        }
    }

    // MARK: Telling the person

    func say(_ text: String) {
        log.info("Notice: \(text, privacy: .public)")
        withAnimation { notice = text }
        Task {
            try? await Task.sleep(for: .seconds(3))
            withAnimation { if notice == text { notice = nil } }
        }
    }
}
