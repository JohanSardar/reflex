import AVFoundation
import PDFKit
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Turning what the person adds (photos, camera captures, PDFs, files) into
/// bytes for assets.
enum Imports {
    /// The largest side an imported picture keeps, in pixels.
    static let maxPixels: CGFloat = 2400

    /// A picture as JPEG, or PNG when it has transparency, no larger than `maxPixels`.
    static func encode(_ image: UIImage) -> Data? {
        let px = CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale)
        let s = min(1, maxPixels / max(px.width, px.height, 1))
        let target = CGSize(width: (px.width * s).rounded(), height: (px.height * s).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let alpha = image.cgImage.map { ![.none, .noneSkipFirst, .noneSkipLast].contains($0.alphaInfo) } ?? false
        format.opaque = !alpha
        let resized = UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
        return alpha ? resized.pngData() : resized.jpegData(compressionQuality: 0.85)
    }

    /// `size` scaled down to fit `box`, keeping its shape.
    static func fit(_ size: CGSize, in box: CGSize) -> CGSize {
        guard size.width > 0, size.height > 0 else { return box }
        let s = min(1, box.width / size.width, box.height / size.height)
        return CGSize(width: (size.width * s).rounded(), height: (size.height * s).rounded())
    }

    /// Every page of a PDF, rendered on white at up to `maxPixels` (at most 100 pages).
    static func pdfPages(_ data: Data) -> [UIImage]? {
        guard let doc = PDFDocument(data: data), doc.pageCount > 0 else { return nil }
        return (0 ..< min(doc.pageCount, 100)).compactMap { i in
            guard let page = doc.page(at: i) else { return nil }
            let box = page.bounds(for: .mediaBox).size
            let s = min(3, maxPixels / max(box.width, box.height, 1))
            return page.thumbnail(of: CGSize(width: box.width * s, height: box.height * s), for: .mediaBox)
        }
    }
}

/// The + menu: Photos, the camera and Files.
struct ImportMenu: View {
    let session: SpaceSession
    @State private var photos: [PhotosPickerItem] = []
    @State private var showPhotos = false
    @State private var showFiles = false
    @State private var showCamera = false

    var body: some View {
        Menu {
            Button { showPhotos = true } label: { Label("Photos", systemImage: "photo.on.rectangle") }
                .accessibilityIdentifier("import-photos")
            Button { showCamera = true } label: { Label("Take Photo", systemImage: "camera") }
                .disabled(!UIImagePickerController.isSourceTypeAvailable(.camera))
                .accessibilityIdentifier("import-camera")
            Button { showFiles = true } label: { Label("Files", systemImage: "folder") }
                .accessibilityIdentifier("import-files")
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 18, weight: .semibold))
                .frame(width: 48, height: 48)
                .glassEffect()
        }
        .accessibilityIdentifier("import-menu")
        .accessibilityLabel("Add photos and files")
        .photosPicker(isPresented: $showPhotos, selection: $photos, maxSelectionCount: 10, matching: .any(of: [.images, .screenshots]))
        .onChange(of: photos) { _, items in
            guard !items.isEmpty else { return }
            photos = []
            Task {
                for item in items {
                    if let data = try? await item.loadTransferable(type: Data.self) {
                        session.importImage(data, name: item.itemIdentifier.map { "Photo \($0.prefix(8))" } ?? "Photo")
                    }
                }
            }
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { for url in urls { session.importFile(url) } }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { image in
                if let image, let data = image.jpegData(compressionQuality: 0.9) {
                    session.importImage(data, name: "Camera photo")
                }
                showCamera = false
            }
            .ignoresSafeArea()
        }
    }
}

/// The system camera, for one photo.
struct CameraPicker: UIViewControllerRepresentable {
    let done: (UIImage?) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(done: done) }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let done: (UIImage?) -> Void
        init(done: @escaping (UIImage?) -> Void) { self.done = done }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            done(info[.originalImage] as? UIImage)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { done(nil) }
    }
}

/// Files and pictures dropped on the canvas from another app.
struct CanvasDrop: DropDelegate {
    let session: SpaceSession

    func validateDrop(info: DropInfo) -> Bool { info.hasItemsConforming(to: [.item]) }

    func performDrop(info: DropInfo) -> Bool {
        let providers = info.itemProviders(for: [.item])
        for p in providers {
            let type = p.registeredContentTypes.first { $0.conforms(to: .pdf) }
                ?? p.registeredContentTypes.first { $0.conforms(to: .image) }
                ?? p.registeredContentTypes.first
            guard let type else { continue }
            let name = p.suggestedName ?? "Dropped file"
            _ = p.loadDataRepresentation(for: type) { data, _ in
                guard let data else { return }
                Task { @MainActor in
                    let ext = type.preferredFilenameExtension.map { name.hasSuffix(".\($0)") ? name : "\(name).\($0)" } ?? name
                    session.importData(data, name: ext, type: type)
                }
            }
        }
        return !providers.isEmpty
    }
}
