import ReflexRender
import SwiftUI

/// Each Region's own Send button ("Check my work"), drawn above the Ink inside the
/// Region's bottom-right corner so a finger or the Pencil can press it. Pressing
/// it sends only the work inside that Region (`SpaceSession.sendRegion`).
struct RegionButtons: View {
    let session: SpaceSession

    var body: some View {
        let zoom = session.ink.zoomScale, offset = session.ink.contentOffset
        Color.clear.overlay(alignment: .topLeading) {
            ZStack(alignment: .topLeading) {
                ForEach(session.regions.filter { !($0.sendButton ?? "").isEmpty }) { r in
                    let f = r.frame!
                    Button {
                        session.sendRegion(r)
                    } label: {
                        Label(r.sendButton ?? "", systemImage: "checkmark.circle")
                            .font(.system(size: 16, weight: .semibold))
                            .padding(.horizontal, 6)
                    }
                    .buttonStyle(.glassProminent)
                    .fixedSize()
                    .padding(12)
                    .frame(width: f.width * zoom, height: f.height * zoom, alignment: .bottomTrailing)
                    .offset(x: f.minX * zoom - offset.x, y: f.minY * zoom - offset.y)
                    .accessibilityIdentifier("region-send-\(r.id)")
                }
            }
        }
        .clipped()
    }
}
