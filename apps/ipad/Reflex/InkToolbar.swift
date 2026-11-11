import ReflexInput
import SwiftUI

/// The floating toolbar: pen colors, the two erasers, lasso, undo and redo.
struct InkToolbar: View {
    let ink: InkCanvasController
    @Binding var showStrokeIDs: Bool

    private static let colors: [(name: String, color: UIColor)] = [
        ("Black", .black),
        ("Blue", UIColor(red: 0.10, green: 0.35, blue: 0.85, alpha: 1)),
        ("Red", UIColor(red: 0.85, green: 0.15, blue: 0.15, alpha: 1)),
    ]

    var body: some View {
        HStack(spacing: 4) {
            ForEach(Self.colors, id: \.name) { item in
                let selected = ink.tool == .pen && ink.penColor == item.color
                Button {
                    ink.penColor = item.color
                    ink.tool = .pen
                } label: {
                    Circle()
                        .fill(Color(item.color))
                        .frame(width: 22, height: 22)
                        .overlay(Circle().stroke(Color.accentColor, lineWidth: selected ? 3 : 0).padding(-4))
                        .frame(width: 40, height: 40)
                }
                .accessibilityLabel("\(item.name) pen")
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
            Divider().frame(height: 24)
            toolButton(.strokeEraser, symbol: "eraser", label: "Stroke eraser")
            toolButton(.preciseEraser, symbol: "eraser.line.dashed", label: "Precise eraser")
            toolButton(.lasso, symbol: "lasso", label: "Lasso")
            Divider().frame(height: 24)
            iconButton("arrow.uturn.backward", label: "Undo", enabled: ink.canUndo) { ink.undo() }
            iconButton("arrow.uturn.forward", label: "Redo", enabled: ink.canRedo) { ink.redo() }
            #if DEBUG
            Divider().frame(height: 24)
            Button {
                showStrokeIDs.toggle()
            } label: {
                Image(systemName: "number").frame(width: 40, height: 40)
                    .foregroundStyle(showStrokeIDs ? Color.accentColor : .primary)
            }
            .accessibilityLabel("Show stroke IDs")
            .accessibilityAddTraits(showStrokeIDs ? .isSelected : [])
            #endif
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .glassEffect()
    }

    private func toolButton(_ tool: InkTool, symbol: String, label: String) -> some View {
        let selected = ink.tool == tool
        return Button {
            ink.tool = tool
        } label: {
            Image(systemName: symbol)
                .font(.system(size: 18, weight: .medium))
                .frame(width: 40, height: 40)
                .foregroundStyle(selected ? Color.white : .primary)
                .background(selected ? Color.accentColor : .clear, in: Circle())
        }
        .accessibilityLabel(label)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func iconButton(_ symbol: String, label: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 18, weight: .medium))
                .frame(width: 40, height: 40)
        }
        .disabled(!enabled)
        .accessibilityLabel(label)
    }
}

/// The floating Send button.
struct SendButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label("Send", systemImage: "paperplane.fill")
                .font(.headline)
                .padding(.horizontal, 22).padding(.vertical, 14)
        }
        .buttonStyle(.glassProminent)
        .accessibilityIdentifier("send-button")
    }
}
