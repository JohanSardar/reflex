import Foundation
import Observation
import SwiftUI
import UIKit

/// The 3D Embeds of one open Space, by Element ID, kept alive across redraws.
@MainActor @Observable
public final class ModelHost {
    /// An asset's bytes, when this iPad has them.
    @ObservationIgnored public var bytes: (String) -> Data? = { _ in nil }
    @ObservationIgnored private var scenes: [String: ModelScene] = [:]

    public init() {}

    /// The scene for an Embed, made the first time (and again if its model changed).
    public func scene(_ id: String, model: String) -> ModelScene {
        if let s = scenes[id], s.modelRef == model { return s }
        let s = ModelScene(modelRef: model)
        scenes[id] = s
        load(s)
        return s
    }

    /// The scene of an Embed that is on the canvas now.
    public func existing(_ id: String) -> ModelScene? { scenes[id] }

    /// Drops the scenes of Embeds that are gone.
    public func keep(_ ids: Set<String>) {
        for id in scenes.keys where !ids.contains(id) { scenes[id] = nil }
    }

    /// An asset arrived: load the models that were waiting for it.
    public func retry() {
        for s in scenes.values where !s.loaded { load(s) }
    }

    private func load(_ s: ModelScene) {
        guard s.modelRef.hasPrefix("asset:"), let data = bytes(String(s.modelRef.dropFirst(6))) else { return }
        Task { await s.load(data) }
    }
}

/// A 3D Embed's RealityKit view in SwiftUI. Touches reach it through the canvas (`SpaceSession`), so the Pencil still draws over it.
public struct ModelView: UIViewRepresentable {
    let scene: ModelScene

    public init(scene: ModelScene) { self.scene = scene }

    public func makeUIView(context: Context) -> Box {
        let box = Box()
        box.attach(scene)
        return box
    }

    public func updateUIView(_ box: Box, context: Context) { box.attach(scene) }

    public static func dismantleUIView(_ box: Box, coordinator: ()) {
        box.subviews.forEach { $0.removeFromSuperview() }
    }

    public final class Box: UIView {
        private weak var scene: ModelScene?

        func attach(_ s: ModelScene) {
            scene = s
            clipsToBounds = true
            isUserInteractionEnabled = false
            if s.view.superview !== self {
                s.view.removeFromSuperview()
                s.view.frame = bounds
                s.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
                addSubview(s.view)
            }
        }

        override public func layoutSubviews() {
            super.layoutSubviews()
            scene?.resized()
        }
    }
}
