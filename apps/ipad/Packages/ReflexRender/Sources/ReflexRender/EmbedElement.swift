import ReflexEmbed
import ReflexModel
import SwiftUI

extension EnvironmentValues {
    /// The live Embeds of the open Space; without one, Embeds draw as placeholders.
    @Entry public var embedHost: EmbedHost? = nil
    /// The open Space's 3D Embeds.
    @Entry public var modelHost: ModelHost? = nil
}

extension EmbedHost {
    /// The server a `ui://` resource belongs to: its authority.
    public static func server(of uri: String?) -> String? {
        guard let uri, uri.hasPrefix("ui://") else { return nil }
        let rest = uri.dropFirst(5).split(separator: "/", maxSplits: 1).first.map(String.init) ?? ""
        return rest.isEmpty ? nil : rest
    }

    /// What an Embed runs, from its inline HTML or its Library template; nil when there is nothing to run here.
    public func spec(template: String?, html: String?, url: String?, params: JSONValue?, data: JSONValue?, state: JSONValue?, allow: [String]?) -> Spec? {
        var code = html
        var hosts = allow ?? []
        var source = url?.hasPrefix("ui://") == true ? url : nil
        if code == nil, let name = template, let t = templates[name] {
            code = t.html
            hosts += t.allow
            source = source ?? t.source
        }
        guard let code else { return nil }
        var props = params?.object ?? [:]
        if let data { props["data"] = data }
        return Spec(html: code, props: JSONValue.object(props).json, state: (state?.object.map(JSONValue.object) ?? .object([:])).json, allow: hosts, server: Self.server(of: source))
    }
}

/// An embed Element on the canvas: its sandboxed web view, or a placeholder when its
/// template isn't here (yet), with what the sandbox stopped shown over it.
struct EmbedElementView: View {
    let element: SceneElement
    @Environment(\.embedHost) private var host
    @Environment(\.modelHost) private var models

    var body: some View {
        Group {
            if let model = element.model {
                ModelEmbedView(element: element, model: model, host: models)
            } else if let host, let spec = host.spec(template: element.template, html: element.html, url: element.url, params: element.params, data: element.data, state: element.state, allow: element.allow) {
                EmbedView(host: host, key: element.id, spec: spec, interactive: false)
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.color("grey").opacity(0.4), lineWidth: 1))
                    .overlay(alignment: .bottomLeading) {
                        if let note = host.notes[element.id] { EmbedNoteView(note: note) }
                    }
            } else {
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color(red: 0.96, green: 0.96, blue: 0.97))
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [6, 4])).foregroundStyle(Palette.color("grey")))
                    .overlay(Text(element.url?.hasPrefix("https://") == true ? "embed: web pages don't open on the iPad" : "embed: \(element.template ?? "html") isn't here yet").font(.caption).foregroundStyle(Palette.color("grey")).padding(6))
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(element.id)
    }
}

/// A 3D Embed: its RealityKit view, with the title the Agent gave it and why it isn't showing, if it isn't.
struct ModelEmbedView: View {
    let element: SceneElement
    let model: String
    let host: ModelHost?

    var body: some View {
        let scene = host?.scene(element.id, model: model)
        ZStack(alignment: .topLeading) {
            Color.white
            if let scene { ModelView(scene: scene) }
            if let title = element.params?.object?["title"].flatMap({ if case .string(let s) = $0 { s } else { nil } }) {
                Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(Color(white: 0.11)).padding(.horizontal, 12).padding(.vertical, 10)
            }
            if let note = scene?.note ?? (host == nil ? "3D model" : nil) {
                Text(note).font(.caption).foregroundStyle(Palette.color("grey")).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.color("grey").opacity(0.4), lineWidth: 1))
        .onChange(of: element, initial: true) { _, e in
            scene?.update(params: (e.params?.any as? [String: Any]) ?? [:], state: (e.state?.any as? [String: Any]) ?? [:])
        }
    }
}
