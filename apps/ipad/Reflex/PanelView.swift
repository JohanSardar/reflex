import ReflexEmbed
import ReflexRender
import SwiftUI

/// A Panel an `open_panel` Behavior opened, drawn natively from its JSON
/// (SPEC §5). Values the person enters fire the Element's `panel_change`
/// Behaviors and go with the next Send.
struct PanelView: View {
    let session: SpaceSession
    let panel: Panel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(panel.title ?? "Details").font(.headline)
                Spacer()
                Button { session.panel = nil } label: {
                    Image(systemName: "xmark").font(.system(size: 14, weight: .semibold)).frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .accessibilityIdentifier("panel-close")
                .accessibilityLabel("Close")
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(panel.components) { c in component(c) }
                }
                .padding(16)
            }
        }
        .frame(width: 340)
        .frame(maxHeight: .infinity)
        .background(Color(.systemBackground).opacity(0.82), in: RoundedRectangle(cornerRadius: 24))
        .glassEffect(in: RoundedRectangle(cornerRadius: 24))
        .contentShape(RoundedRectangle(cornerRadius: 24))
        .accessibilityIdentifier("panel")
    }

    @ViewBuilder
    private func component(_ c: Panel.Component) -> some View {
        switch c.kind {
        case "text":
            Text(c.text ?? "")
        case "markdown":
            Text((try? AttributedString(markdown: c.text ?? "", options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(c.text ?? ""))
        case "button":
            Button(c.label ?? "OK") { session.panelButton(c) }
                .buttonStyle(.glassProminent)
                .accessibilityIdentifier("panel-\(c.id)")
        case "choice":
            choice(c)
        case "text_field":
            TextField(c.label ?? "", text: Binding(
                get: { if case .string(let s)? = session.panelValue(c.key) { s } else { "" } },
                set: { set(c, .string($0)) }
            ))
            .textFieldStyle(.roundedBorder)
            .accessibilityIdentifier("panel-\(c.id)")
        case "number", "slider":
            let value = number(c)
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(c.label ?? "")
                    Spacer()
                    Text(value.formatted(.number.precision(.fractionLength(0 ... 2)))).monospacedDigit().foregroundStyle(.secondary)
                }
                if c.kind == "slider" {
                    Slider(value: Binding(get: { value }, set: { set(c, .number($0)) }), in: (c.min ?? 0) ... max(c.max ?? 100, (c.min ?? 0) + 0.001), step: c.step ?? 1)
                        .accessibilityIdentifier("panel-\(c.id)")
                } else {
                    Stepper(c.label ?? "", value: Binding(get: { value }, set: { set(c, .number($0)) }), in: (c.min ?? -1e9) ... (c.max ?? 1e9), step: c.step ?? 1)
                        .labelsHidden()
                        .accessibilityIdentifier("panel-\(c.id)")
                }
            }
        case "toggle":
            Toggle(c.label ?? "", isOn: Binding(
                get: { if case .bool(let b)? = session.panelValue(c.key) { b } else { false } },
                set: { set(c, .bool($0)) }
            ))
            .accessibilityIdentifier("panel-\(c.id)")
        case "embed":
            embed(c)
        default:
            Label("\(c.kind) isn't shown on this iPad yet", systemImage: "square.dashed").foregroundStyle(.secondary)
        }
    }

    /// An Embed inside the Panel, with the same bridge and sandbox as on the canvas. It
    /// takes touches, and what it saves with setState is this component's value.
    @ViewBuilder
    private func embed(_ c: Panel.Component) -> some View {
        let state: JSONValue? = if case .object? = session.panelValue(c.id) { session.panelValue(c.id) } else { nil }
        if let element = session.panel?.element,
           let spec = session.embeds.spec(template: c.template, html: c.html, url: nil, params: c.params, data: nil, state: state, allow: nil) {
            let key = SpaceSession.panelKey(element, c)
            EmbedView(host: session.embeds, key: key, spec: spec, interactive: true)
                .frame(height: min(max(c.h ?? 240, 40), 1200))
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.secondary.opacity(0.3), lineWidth: 1))
                .overlay(alignment: .bottomLeading) {
                    if let note = session.embeds.notes[key] { EmbedNoteView(note: note) }
                }
                .accessibilityIdentifier("panel-\(c.id)")
        } else {
            Label("\(c.template ?? "This Embed") isn't on this iPad yet", systemImage: "square.dashed").foregroundStyle(.secondary)
        }
    }

    private func choice(_ c: Panel.Component) -> some View {
        let selected: [String] = switch session.panelValue(c.key) {
        case .string(let s)?: [s]
        case .array(let a)?: a.compactMap { if case .string(let s) = $0 { s } else { nil } }
        default: []
        }
        return VStack(alignment: .leading, spacing: 6) {
            if let label = c.label { Text(label).font(.subheadline).foregroundStyle(.secondary) }
            FlowChips(options: c.options ?? [], selected: selected) { option in
                if c.multiple == true {
                    let next = selected.contains(option) ? selected.filter { $0 != option } : selected + [option]
                    set(c, .array(next.map(JSONValue.string)))
                } else {
                    set(c, .string(option))
                }
            }
        }
        .accessibilityIdentifier("panel-\(c.id)")
    }

    private func number(_ c: Panel.Component) -> Double {
        if case .number(let n)? = session.panelValue(c.key) { return n }
        return c.min ?? 0
    }

    private func set(_ c: Panel.Component, _ v: JSONValue) {
        guard let key = c.key else { return }
        session.setPanelValue(v, for: key)
    }
}

/// Choice chips that wrap onto new lines.
struct FlowChips: View {
    let options: [String]
    let selected: [String]
    let pick: (String) -> Void

    var body: some View {
        FlowLayout(spacing: 6) {
            ForEach(options, id: \.self) { option in
                let on = selected.contains(option)
                Button { pick(option) } label: {
                    Text(option).font(.callout)
                        .padding(.horizontal, 12).padding(.vertical, 6)
                        .foregroundStyle(on ? Color.white : Color.primary)
                        .background(on ? Color.accentColor : Color.secondary.opacity(0.12), in: Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
    }
}

struct FlowLayout: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(proposal.width ?? .infinity, subviews)
        return CGSize(width: proposal.width ?? rows.map(\.width).max() ?? 0, height: rows.last.map { $0.y + $0.height } ?? 0)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var i = 0
        for row in arrange(bounds.width, subviews) {
            var x = bounds.minX
            for _ in 0 ..< row.count {
                let size = subviews[i].sizeThatFits(.unspecified)
                subviews[i].place(at: CGPoint(x: x, y: bounds.minY + row.y), proposal: .unspecified)
                x += size.width + spacing
                i += 1
            }
        }
    }

    private func arrange(_ width: CGFloat, _ subviews: Subviews) -> [(count: Int, y: CGFloat, width: CGFloat, height: CGFloat)] {
        var rows: [(count: Int, y: CGFloat, width: CGFloat, height: CGFloat)] = []
        var x: CGFloat = 0, y: CGFloat = 0, h: CGFloat = 0, n = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if n > 0, x + size.width > width {
                rows.append((n, y, x - spacing, h))
                y += h + spacing
                x = 0; h = 0; n = 0
            }
            x += size.width + spacing
            h = max(h, size.height)
            n += 1
        }
        if n > 0 { rows.append((n, y, x - spacing, h)) }
        return rows
    }
}
