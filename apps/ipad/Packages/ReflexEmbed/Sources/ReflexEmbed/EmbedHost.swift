import CryptoKit
import Foundation
import Observation
import OSLog
import UIKit
import WebKit

private let log = Logger(subsystem: "si.eilmer.reflex", category: "embed")

/// HTML Embeds on the iPad (SPEC §5, ARCHITECTURE §5). Each Embed runs in its own
/// sandboxed WKWebView:
/// - a nonpersistent data store: no cookies, storage or credentials survive or are shared
/// - no network by default: a content rule list blocks every load except code (scripts,
///   styles, fonts, images) from the approved CDNs and anything from the Embed's own `allow`
///   hosts, and the same Content Security Policy as on the web
/// - no navigation, popups, dialogs or links
/// - the `reflex` bridge (`bridge.js`, the same file the web viewer runs) as its only way out,
///   and it only ever reaches its own Element
/// - limits: an Embed that stops answering for 5 s (a busy loop) or whose process dies (memory)
///   is stopped; state, payloads and Panels over 16 KB and more than 10 events in 10 s are refused
///
/// What the sandbox stops is shown on the Embed (`notes`).
@MainActor @Observable
public final class EmbedHost {
    /// What one Embed runs.
    public struct Spec: Equatable, Sendable {
        public var html: String
        /// JSON object: its params, with its `data` map as `data`.
        public var props: String
        /// JSON object: its saved state.
        public var state: String
        public var allow: [String]
        /// For an MCP App view: the server its `ui://` resource came from.
        public var server: String?
        /// The template asks to be drawn without a background or border (`<meta name="reflex-background" content="transparent">`).
        public var transparent: Bool {
            html.range(of: #"<meta\s+name=["']reflex-background["']\s+content=["']transparent["']"#, options: [.regularExpression, .caseInsensitive]) != nil
        }

        public init(html: String, props: String, state: String, allow: [String], server: String?) {
            self.html = html
            self.props = props
            self.state = state
            self.allow = allow
            self.server = server
        }

        /// The same Embed, ignoring state.
        func sameCode(_ o: Spec) -> Bool { html == o.html && props == o.props && allow == o.allow && server == o.server }
    }

    /// An Embed Template from the person's Library.
    public struct Template: Sendable, Equatable {
        public var html: String
        public var allow: [String]
        public var source: String?
        public init(html: String, allow: [String], source: String?) {
            self.html = html
            self.allow = allow
            self.source = source
        }
    }

    public enum Event {
        /// `reflex.element.setState(patch)`.
        case setState([String: Any])
        /// `reflex.notify(payload)`.
        case notify([String: Any])
        /// `reflex.emit(name, payload)`.
        case emit(String, [String: Any])
        /// `reflex.panel.open(spec)`, a Panel as JSON.
        case panel([String: Any])
        /// An MCP App view called one of its server's tools, which the person allowed.
        case toolCall(server: String, name: String, arguments: [String: Any])
        /// An MCP App view's `ui/message`.
        case message([String: Any])
    }

    /// Approved CDNs: code may load from them, data may not (SPEC §5).
    public static let approvedCDNs = ["cdn.jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com", "esm.sh"]
    static let limit = 16 * 1024
    static let stallSeconds: TimeInterval = 5

    /// Templates by name, from the person's Library.
    public var templates: [String: Template] = [:]
    /// What the sandbox stopped, by Embed key, for the person to see.
    public private(set) var notes: [String: Note] = [:]
    /// MCP servers whose tools the person let their views call, kept on this iPad.
    public private(set) var allowedServers: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "reflex.embed.allowedServers") ?? [])
    /// Events from Embeds, by Embed key.
    @ObservationIgnored public var onEvent: ((String, Event) -> Void)?

    public struct Note: Equatable, Sendable {
        public var text: String
        /// An MCP server the person could allow, when a tool call was denied.
        public var server: String?
        public var stopped: Bool
    }

    @ObservationIgnored private var live: [String: Live] = [:]
    @ObservationIgnored private var watchdog: Timer?
    @ObservationIgnored private var pending: [String: CheckedContinuation<String?, Never>] = [:]

    final class Live {
        let key: String
        let web: WKWebView
        var spec: Spec
        /// The state as the Embed itself last saved it, so its own saves don't reload it.
        var local: String
        var beat = Date().addingTimeInterval(10)
        var anchors = false
        var stopped = false
        var events: [Date] = []
        let delegate: Delegate
        init(key: String, web: WKWebView, spec: Spec, delegate: Delegate) {
            self.key = key
            self.web = web
            self.spec = spec
            self.local = spec.state
            self.delegate = delegate
        }
    }

    public init() {}

    // MARK: Views

    /// The web view for one Embed, made on first use and kept while it is shown. A
    /// change of template, params or allowlist reloads it, and so does state saved on
    /// another device; its own saves don't.
    public func webView(_ key: String, spec: Spec) -> WKWebView {
        if let l = live[key] {
            if !l.spec.sameCode(spec) || (!Self.sameJSON(spec.state, l.spec.state) && !Self.sameJSON(spec.state, l.local)) {
                l.spec = spec
                l.local = spec.state
                l.stopped = false
                notes[key] = nil
                load(l)
            } else {
                l.spec = spec
            }
            return l.web
        }
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.preferences.isFraudulentWebsiteWarningEnabled = true
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = .all
        config.allowsAirPlayForMediaPlayback = false
        config.allowsPictureInPictureMediaPlayback = false
        config.dataDetectorTypes = []
        config.upgradeKnownHostsToHTTPS = true
        let delegate = Delegate(key: key, host: self)
        config.userContentController.add(delegate, name: "reflex")
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 320, height: 240), configuration: config)
        web.isOpaque = false
        web.backgroundColor = spec.transparent ? .clear : .white
        web.scrollView.backgroundColor = spec.transparent ? .clear : .white
        web.scrollView.isScrollEnabled = false
        web.scrollView.bounces = false
        web.allowsLinkPreview = false
        web.allowsBackForwardNavigationGestures = false
        web.navigationDelegate = delegate
        web.uiDelegate = delegate
        web.accessibilityIdentifier = "embed-\(key)"
        let l = Live(key: key, web: web, spec: spec, delegate: delegate)
        live[key] = l
        load(l)
        startWatchdog()
        return web
    }

    /// Stops and forgets an Embed that is no longer shown.
    public func release(_ key: String) {
        guard let l = live.removeValue(forKey: key) else { return }
        l.web.configuration.userContentController.removeScriptMessageHandler(forName: "reflex")
        l.web.stopLoading()
        l.web.removeFromSuperview()
        notes[key] = nil
    }

    /// Keeps only the Embeds whose keys are given.
    public func keep(_ keys: Set<String>) {
        for k in live.keys where !keys.contains(k) { release(k) }
    }

    public func isStopped(_ key: String) -> Bool { live[key]?.stopped ?? false }

    /// Runs a stopped Embed again.
    public func restart(_ key: String) {
        guard let l = live[key] else { return }
        l.stopped = false
        notes[key] = nil
        load(l)
    }

    /// Lets this server's MCP App views call its tools; the calls go to the Agent that placed them.
    public func allow(server: String) {
        allowedServers.insert(server)
        UserDefaults.standard.set(Array(allowedServers).sorted(), forKey: "reflex.embed.allowedServers")
        for (k, n) in notes where n.server == server { notes[k] = nil }
    }

    // MARK: Anchors

    /// Asks an Embed what a Mark points at: `points` and `bounds` in the Embed's own pixels.
    /// Nil when it registered no resolver, is stopped, or doesn't answer in time.
    public func resolve(_ key: String, points: [[Double]], bounds: [Double], timeout: Double = 1.5) async -> [String: Any]? {
        guard let l = live[key], l.anchors, !l.stopped else { return nil }
        let id = UUID().uuidString
        let message: [String: Any] = ["t": "resolve", "id": id, "region": ["points": points, "bounds": bounds]]
        let answer = await withCheckedContinuation { (c: CheckedContinuation<String?, Never>) in
            pending[id] = c
            send(l, message)
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(timeout))
                self?.pending.removeValue(forKey: id)?.resume(returning: nil)
            }
        }
        return answer.flatMap { (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any] }
    }

    // MARK: Loading

    private func load(_ l: Live) {
        let spec = l.spec
        guard spec.html.utf8.count <= 400_000 else {
            stop(l, "Stopped: the Embed is over 200,000 characters")
            return
        }
        let document = Self.document(spec)
        let rules = Self.rules(allow: spec.allow)
        Task { @MainActor in
            let list = await Self.compile(rules)
            guard let current = self.live[l.key], current === l else { return }
            l.web.configuration.userContentController.removeAllContentRuleLists()
            if let list {
                l.web.configuration.userContentController.add(list)
            } else {
                // Without its network rules an Embed doesn't run at all.
                self.stop(l, "Stopped: its network rules couldn't be set up")
                return
            }
            l.beat = Date().addingTimeInterval(10)
            l.anchors = false
            l.delegate.loading = true
            l.web.loadHTMLString(document, baseURL: nil)
        }
    }

    private static func json(_ v: Any) -> String {
        guard JSONSerialization.isValidJSONObject(v), let d = try? JSONSerialization.data(withJSONObject: v, options: [.sortedKeys]) else { return "{}" }
        return String(decoding: d, as: UTF8.self)
    }

    static func sameJSON(_ a: String, _ b: String) -> Bool {
        let parse = { (s: String) in (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? NSDictionary }
        return parse(a) == parse(b)
    }

    private static let bridge: String = {
        guard let url = Bundle.module.url(forResource: "bridge", withExtension: "js"), let s = try? String(contentsOf: url, encoding: .utf8) else {
            log.fault("bridge.js is missing from the app")
            return "throw new Error('Reflex bridge missing')"
        }
        return s
    }()

    private static func hosts(_ h: [String]) -> [String] {
        h.filter { $0.range(of: "^[a-z0-9.-]{1,253}$", options: .regularExpression) != nil }
    }

    /// The document an Embed runs, as on the web (`apps/web/src/embed.ts`): CSP first, then the bridge, then the template.
    static func document(_ spec: Spec) -> String {
        let own = Array(Set(hosts(spec.allow))).sorted().map { "https://\($0)" }
        let code = Array(Set(hosts(spec.allow + approvedCDNs))).sorted().map { "https://\($0)" }.joined(separator: " ")
        let connect = own.isEmpty ? "'none'" : (own + own.map { $0.replacingOccurrences(of: "https://", with: "wss://") }).joined(separator: " ")
        let csp = [
            "default-src 'none'",
            "script-src 'unsafe-inline' 'unsafe-eval' \(code)",
            "style-src 'unsafe-inline' \(code)",
            "img-src data: blob: \(code)",
            "font-src data: \(code)",
            "media-src data: blob: \(own.joined(separator: " "))",
            "connect-src \(connect)",
            "worker-src 'none'",
            "frame-src 'none'",
            "form-action 'none'",
            "base-uri 'none'",
        ].joined(separator: "; ")
        var config: [String: Any] = [
            "props": (try? JSONSerialization.jsonObject(with: Data(spec.props.utf8))) ?? [:],
            "state": (try? JSONSerialization.jsonObject(with: Data(spec.state.utf8))) ?? [:],
        ]
        if let server = spec.server { config["mcp"] = ["server": server] }
        let safe = json(config)
            .replacingOccurrences(of: "<", with: "\\u003c")
            .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
        let script = bridge.replacingOccurrences(of: "__REFLEX_CONFIG__", with: safe)
        let head = "<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><meta http-equiv=\"Content-Security-Policy\" content=\"\(csp)\"><script>\(script)</script>"
        if let r = spec.html.range(of: "<head[^>]*>", options: [.regularExpression, .caseInsensitive]) {
            return spec.html.replacingCharacters(in: r, with: spec.html[r] + head)
        }
        return "<!doctype html><html><head>\(head)</head><body>\(spec.html)</body></html>"
    }

    /// The content rule list: block every load, then let code through from the approved CDNs and anything from the Embed's own hosts.
    static func rules(allow: [String]) -> String {
        let esc = { (h: String) in h.replacingOccurrences(of: ".", with: "\\\\.") }
        var rules: [String] = [#"{"trigger":{"url-filter":"^[a-z][a-z0-9+.-]*://"},"action":{"type":"block"}}"#]
        for h in approvedCDNs {
            rules.append(#"{"trigger":{"url-filter":"^https://([^/]*\\.)?\#(esc(h))[:/]","resource-type":["script","style-sheet","font","image"]},"action":{"type":"ignore-previous-rules"}}"#)
        }
        for h in hosts(allow) {
            rules.append(#"{"trigger":{"url-filter":"^(https|wss)://([^/]*\\.)?\#(esc(h))[:/]"},"action":{"type":"ignore-previous-rules"}}"#)
        }
        return "[\(rules.joined(separator: ","))]"
    }

    private static var compiled: [String: WKContentRuleList] = [:]

    private static func compile(_ rules: String) async -> WKContentRuleList? {
        let id = "reflex-embed-" + SHA256.hash(data: Data(rules.utf8)).prefix(12).map { String(format: "%02x", $0) }.joined()
        if let l = compiled[id] { return l }
        do {
            guard let l = try await WKContentRuleListStore.default().compileContentRuleList(forIdentifier: id, encodedContentRuleList: rules) else { return nil }
            compiled[id] = l
            return l
        } catch {
            log.error("Embed rules failed to compile: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    // MARK: Messages

    private func send(_ l: Live, _ message: [String: Any]) {
        l.web.evaluateJavaScript("window.__reflexReceive(\(Self.json(message)))") { _, error in
            if let error { log.error("Embed \(l.key, privacy: .public) didn't take a message: \(error.localizedDescription, privacy: .public)") }
        }
    }

    private func note(_ l: Live, _ text: String, server: String? = nil) {
        log.info("Embed \(l.key, privacy: .public): \(text, privacy: .public)")
        notes[l.key] = Note(text: String(text.prefix(300)), server: server, stopped: l.stopped)
    }

    private func stop(_ l: Live, _ text: String) {
        l.stopped = true
        l.web.stopLoading()
        l.web.loadHTMLString("<!doctype html><html><body style='background:#f4f4f6'></body></html>", baseURL: nil)
        note(l, text)
    }

    /// More than 10 events in 10 seconds is refused.
    private func allowEvent(_ l: Live) -> Bool {
        let now = Date()
        l.events = l.events.filter { now.timeIntervalSince($0) < 10 }
        guard l.events.count < 10 else {
            note(l, "Blocked events: more than 10 in 10 seconds")
            return false
        }
        l.events.append(now)
        return true
    }

    fileprivate func received(_ key: String, _ body: Any) {
        guard let l = live[key], !l.stopped, let m = body as? [String: Any], let t = m["t"] as? String else { return }
        l.beat = Date()
        let object = { (k: String) -> [String: Any]? in
            guard let o = m[k] as? [String: Any] else { return [:] }
            return Self.json(o).utf8.count <= Self.limit ? o : nil
        }
        switch t {
        case "beat", "ready":
            return
        case "anchors":
            l.anchors = true
        case "resolved":
            if let id = m["id"] as? String { pending.removeValue(forKey: id)?.resume(returning: (m["anchor"] as? [String: Any]).map(Self.json)) }
        case "blocked":
            note(l, "Blocked \(m["what"] as? String ?? "a request"): \(m["detail"] as? String ?? "")")
        case "setState":
            guard let patch = object("patch") else { return note(l, "Blocked state: over 16 KB") }
            var state = ((try? JSONSerialization.jsonObject(with: Data(l.local.utf8))) as? [String: Any]) ?? [:]
            for (k, v) in patch { if v is NSNull { state[k] = nil } else { state[k] = v } }
            let next = Self.json(state)
            guard next.utf8.count <= Self.limit else { return note(l, "Blocked state: over 16 KB") }
            l.local = next
            onEvent?(key, .setState(patch))
        case "notify":
            guard let payload = object("payload") else { return note(l, "Blocked an event over 16 KB") }
            if allowEvent(l) { onEvent?(key, .notify(payload)) }
        case "emit":
            guard let name = m["name"] as? String, name.range(of: "^[a-z][a-z0-9_]{0,39}$", options: .regularExpression) != nil,
                  let payload = object("payload") else { return note(l, "Blocked an event it named badly or over 16 KB") }
            if allowEvent(l) { onEvent?(key, .emit(name, payload)) }
        case "panel":
            guard let spec = object("spec"), !spec.isEmpty else { return note(l, "Blocked a Panel over 16 KB") }
            if allowEvent(l) { onEvent?(key, .panel(spec)) }
        case "mcp_message":
            if let msg = object("message"), allowEvent(l) { onEvent?(key, .message(msg)) }
        case "tool_call":
            guard let id = m["id"] as? String else { return }
            let name = m["name"] as? String ?? ""
            let server = l.spec.server ?? "its server"
            if l.spec.server.map(allowedServers.contains) == true, let args = object("arguments"), allowEvent(l) {
                onEvent?(key, .toolCall(server: server, name: name, arguments: args))
                send(l, ["t": "rpc", "id": id, "result": ["content": [["type": "text", "text": "Reflex passed this call to the Agent that placed this view; it answers by updating the view."]]]])
            } else {
                note(l, "Blocked a call to \(server)'s tool \(name)", server: l.spec.server)
                send(l, ["t": "rpc", "id": id, "error": ["code": -32000, "message": "Reflex denied \(name): the person hasn't allowed \(server)'s tools."]])
            }
        default:
            return
        }
    }

    // MARK: Limits

    private func startWatchdog() {
        guard watchdog == nil else { return }
        watchdog = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.check() }
        }
    }

    private func check() {
        let now = Date()
        for l in live.values where !l.stopped && l.web.window != nil && !l.delegate.loading {
            if now.timeIntervalSince(l.beat) > Self.stallSeconds {
                stop(l, "Stopped: it kept the processor busy and stopped answering")
            }
        }
        if live.isEmpty {
            watchdog?.invalidate()
            watchdog = nil
        }
    }

    fileprivate func blockedNavigation(_ key: String, _ url: URL?) {
        guard let l = live[key] else { return }
        note(l, "Blocked opening \(url?.absoluteString.prefix(120) ?? "a page"): Embeds stay on their own page")
    }

    fileprivate func terminated(_ key: String) {
        guard let l = live[key] else { return }
        l.stopped = true
        note(l, "Stopped: it used too much memory")
    }

    fileprivate func loaded(_ key: String) {
        live[key]?.beat = Date()
    }

    /// Bridges WebKit's callbacks to the host without keeping it alive.
    @MainActor
    final class Delegate: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
        let key: String
        weak var host: EmbedHost?
        var loading = true

        init(key: String, host: EmbedHost) {
            self.key = key
            self.host = host
        }

        func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
            let body = message.body
            host?.received(key, body)
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            // Only the Embed's own document, which the host loads; never another page or a link.
            if action.request.url?.absoluteString == "about:blank", action.navigationType == .other, action.targetFrame?.isMainFrame == true { return .allow }
            host?.blockedNavigation(key, action.request.url)
            return .cancel
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            loading = false
            host?.loaded(key)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            host?.terminated(key)
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            host?.blockedNavigation(key, action.request.url)
            return nil
        }

        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async {}
        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async -> Bool { false }
        func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo) async -> String? { nil }
    }
}
