import PencilKit
import PhotosUI
import ReflexInput
import ReflexLink
import SwiftUI
import UniformTypeIdentifiers

/// Alignment and drawing switches, kept for every board.
struct BoardSettings {
    @AppStorage("snapToGrid") var snapToGrid = false
    @AppStorage("centerGuides") var centerGuides = true
    @AppStorage("edgeGuides") var edgeGuides = true
    @AppStorage("spacingGuides") var spacingGuides = true
}

/// One board: paper, objects, ink and the chrome around them.
struct BoardScreen: View {
    let session: BoardSession
    let link: LinkSync
    let voice: VoiceCapture
    let library: BoardLibrary
    let onBack: () -> Void
    let onStatus: () -> Void

    @Environment(\.colorScheme) private var scheme
    @AppStorage("snapToGrid") private var snapToGrid = false
    @AppStorage("centerGuides") private var centerGuides = true
    @AppStorage("edgeGuides") private var edgeGuides = true
    @AppStorage("spacingGuides") private var spacingGuides = true
    @AppStorage("fingerDraws") private var fingerDraws = true

    @State private var showPaper = false
    @State private var showShapes = false
    @State private var showLibrary = false
    @State private var showPhotos = false
    @State private var photoItem: PhotosPickerItem?
    @State private var showFiles = false
    @State private var showCamera = false
    @State private var showScenes = false
    @State private var renaming = false
    @State private var draftTitle = ""
    @State private var exportURL: URL?
    @State private var screen: CGSize = .zero
    @FocusState private var titleFocused: Bool

    private var ink: InkCanvasController { session.ink }
    private var paper: Paper { session.meta.paper }
    private var darkPaper: Bool { paper.tint.isDark(system: scheme == .dark) }

    private var guideSettings: BoardSession.GuideSettings {
        .init(snapToGrid: snapToGrid, center: centerGuides, edges: edgeGuides, spacing: spacingGuides, grid: paper.spacing.points)
    }

    var body: some View {
        ZStack {
            paper.tint.color(dark: scheme == .dark).ignoresSafeArea()
            PaperLayer(ink: ink, paper: paper, dark: darkPaper).ignoresSafeArea()
            ObjectsLayer(session: session, darkPaper: darkPaper).ignoresSafeArea()
            InkCanvas(controller: ink).ignoresSafeArea()
            InteractionLayer(session: session, darkPaper: darkPaper, guides: guideSettings, screen: screen).ignoresSafeArea()
        }
        .onGeometryChange(for: CGSize.self) { $0.size } action: { screen = $0 }
        .overlay(alignment: .top) { topBar }
        .overlay(alignment: .bottomLeading) { zoomCapsule.padding(.leading, 16).padding(.bottom, bottomLift + 16) }
        .overlay(alignment: .bottomTrailing) { bottomRight.padding(.trailing, 16 + trailingLift).padding(.bottom, bottomLift + 16) }
        .overlay(alignment: .bottom) { messages.padding(.bottom, bottomLift + 92) }
        .onAppear {
            ink.fingerDraws = fingerDraws
            applyPaperStyle()
            session.restoreViewport()
        }
        .onChange(of: fingerDraws) { _, v in ink.fingerDraws = v }
        .onChange(of: darkPaper) { _, _ in applyPaperStyle() }
        .onChange(of: ink.pickerVisible) { _, visible in if visible { session.clearSelection() } }
        .photosPicker(isPresented: $showPhotos, selection: $photoItem, matching: .images)
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            Task {
                if let data = try? await item.loadTransferable(type: Data.self) { session.addImage(data) }
                photoItem = nil
            }
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.image]) { result in
            guard case .success(let url) = result else { return }
            let ok = url.startAccessingSecurityScopedResource()
            defer { if ok { url.stopAccessingSecurityScopedResource() } }
            if let data = try? Data(contentsOf: url) { session.addImage(data) }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { data in session.addImage(data) }.ignoresSafeArea()
        }
        .sheet(isPresented: $showLibrary) {
            ShapeLibrary { choice in
                switch choice {
                case .shape(let k): session.addShape(k)
                case .symbol(let s): session.addSymbol(s)
                }
            }
        }
        .sheet(item: Binding(get: { exportURL.map(ExportItem.init) }, set: { if $0 == nil { exportURL = nil } })) { item in
            ShareSheet(url: item.url)
        }
    }

    private func applyPaperStyle() {
        ink.canvasView.overrideUserInterfaceStyle = darkPaper ? .dark : .light
        ink.toolPicker.colorUserInterfaceStyle = darkPaper ? .dark : .light
    }

    // MARK: Lifting the chrome above the docked palette

    private var bottomLift: CGFloat {
        let r = ink.pickerObscured
        guard ink.pickerVisible, !r.isNull, screen.height > 0, r.width > screen.width * 0.4, r.minY > screen.height * 0.55 else { return 0 }
        return max(0, screen.height - r.minY - 8)
    }

    private var trailingLift: CGFloat {
        let r = ink.pickerObscured
        guard ink.pickerVisible, !r.isNull, screen.width > 0, r.minX > screen.width * 0.6, r.maxY > screen.height - 110 else { return 0 }
        return max(0, screen.width - r.minX)
    }

    // MARK: Top bar

    private var foldInsertTools: Bool { screen.width < 900 || (screen.width < 1150 && session.meta.title.count > 22) }

    private var topBar: some View {
        HStack(spacing: 10) {
            GlassEffectContainer(spacing: 8) {
                HStack(spacing: 8) {
                    Button(action: onBack) {
                        Image(systemName: "chevron.left").font(.system(size: 18, weight: .semibold)).frame(width: 44, height: 44)
                    }
                    .foregroundStyle(.primary)
                    .glassEffect(.regular.interactive(), in: Circle())
                    .accessibilityLabel("All Boards")
                    .accessibilityIdentifier("back-button")
                    titleControl
                }
            }
            Spacer(minLength: 8)
            if foldInsertTools { plusMenu } else { insertCapsule }
            Spacer(minLength: 8)
            undoCapsule
            StatusCapsule(link: link, compact: screen.width < 900, action: onStatus)
        }
        .padding(.horizontal, 16)
        .padding(.top, 6)
    }

    @ViewBuilder private var titleControl: some View {
        if renaming {
            TextField("Title", text: $draftTitle)
                .font(.system(size: 17, weight: .semibold))
                .focused($titleFocused)
                .submitLabel(.done)
                .onSubmit(finishRename)
                .onChange(of: titleFocused) { _, f in if !f { finishRename() } }
                .frame(width: 240, height: 44)
                .padding(.horizontal, 14)
                .glassEffect(.regular, in: Capsule())
                .accessibilityIdentifier("title-field")
        } else {
            Menu {
                Button("Rename", systemImage: "pencil") { startRename() }
                Button(session.meta.favorite ? "Unfavorite" : "Favorite", systemImage: session.meta.favorite ? "heart.slash" : "heart") {
                    library.toggleFavorite(session.id)
                }
                Menu("Move to", systemImage: "folder") {
                    Button("No Folder", systemImage: session.meta.folder == nil ? "checkmark" : "tray") { library.move([session.id], to: nil) }
                    ForEach(library.folders) { f in
                        Button(library.path(f.id), systemImage: session.meta.folder == f.id ? "checkmark" : "folder") { library.move([session.id], to: f.id) }
                    }
                }
                Divider()
                Button("Paper…", systemImage: "doc.richtext") { showPaper = true }
                exportMenu
            } label: {
                HStack(spacing: 6) {
                    if session.meta.favorite { Image(systemName: "heart.fill").font(.system(size: 13)).foregroundStyle(.pink) }
                    Text(shortTitle).font(.system(size: 17, weight: .semibold)).lineLimit(1)
                    Image(systemName: "chevron.down.circle.fill").font(.system(size: 15)).symbolRenderingMode(.hierarchical).foregroundStyle(.secondary)
                }
                .padding(.horizontal, 14).frame(height: 44)
                .fixedSize()
                .contentShape(Capsule())
            }
            .glassEffect(.regular.interactive(), in: Capsule())
            .foregroundStyle(.primary)
            .accessibilityIdentifier("title-menu")
        }
    }

    private var shortTitle: String {
        let t = session.meta.title
        let limit = screen.width < 900 ? 18 : 30
        return t.count > limit ? t.prefix(limit - 1) + "…" : t
    }

    private var exportMenu: some View {
        Menu("Export as PDF", systemImage: "arrow.up.doc") {
            Button("Board", systemImage: "rectangle.on.rectangle") { exportBoard() }
            Button("Scenes", systemImage: "rectangle.stack") { exportScenes() }.disabled(session.meta.scenes.isEmpty)
        }
    }

    private func startRename() {
        draftTitle = session.meta.title
        renaming = true
        DispatchQueue.main.async { titleFocused = true }
    }

    private func finishRename() {
        guard renaming else { return }
        renaming = false
        library.rename(session.id, draftTitle)
    }

    private func exportBoard() {
        session.ink.flush()
        let r = (session.contentBounds ?? ink.visibleRect).insetBy(dx: -40, dy: -40)
        exportURL = BoardRenderer.pdf(pages: [r], drawing: ink.drawing, objects: session.objects, files: session.files, paper: paper, name: session.meta.title)
    }

    private func exportScenes() {
        session.ink.flush()
        exportURL = BoardRenderer.pdf(pages: session.meta.scenes.map(\.rect), drawing: ink.drawing, objects: session.objects, files: session.files, paper: paper, name: "\(session.meta.title) Scenes")
    }

    // MARK: Insert tools

    private var insertCapsule: some View {
        HStack(spacing: 2) {
            toolButton("pencil.tip.crop.circle", "Drawing Tools", on: ink.pickerVisible) { ink.setPickerVisible(!ink.pickerVisible) }
                .accessibilityIdentifier("tool-pen")
            toolButton("character.textbox", "Text") { session.addText() }.accessibilityIdentifier("insert-text")
            toolButton("square.on.circle", "Shape") { showShapes = true }
                .accessibilityIdentifier("insert-shape")
                .popover(isPresented: $showShapes) { shapePopover }
            toolButton("note.text", "Sticky Note") { session.addSticky() }.accessibilityIdentifier("insert-sticky")
            toolButton("tablecells", "Table") { session.addTable() }.accessibilityIdentifier("insert-table")
            Menu { mediaItems } label: {
                Image(systemName: "photo.on.rectangle.angled").font(.system(size: 19, weight: .regular)).frame(width: 46, height: 44)
            }
            .accessibilityLabel("Insert Media")
            .accessibilityIdentifier("insert-media")
        }
        .padding(.horizontal, 6)
        .foregroundStyle(.primary)
        .glassEffect(.regular, in: Capsule())
    }

    private var plusMenu: some View {
        HStack(spacing: 8) {
            Button { ink.setPickerVisible(!ink.pickerVisible) } label: {
                Image(systemName: "pencil.tip.crop.circle").font(.system(size: 19)).frame(width: 44, height: 44)
                    .foregroundStyle(ink.pickerVisible ? Color.white : .primary)
                    .background(ink.pickerVisible ? Color.accentColor : .clear, in: Circle())
            }
            .glassEffect(.regular.interactive(), in: Circle())
            .accessibilityLabel("Drawing Tools")
            .accessibilityIdentifier("tool-pen")
            Menu {
                Button("Text", systemImage: "character.textbox") { session.addText() }
                Button("Shape…", systemImage: "square.on.circle") { showShapes = true }
                Button("Sticky Note", systemImage: "note.text") { session.addSticky() }
                Button("Table", systemImage: "tablecells") { session.addTable() }
                Menu("Media", systemImage: "photo.on.rectangle.angled") { mediaItems }
            } label: {
                Image(systemName: "plus").font(.system(size: 20, weight: .medium)).frame(width: 44, height: 44)
            }
            .glassEffect(.regular.interactive(), in: Circle())
            .foregroundStyle(.primary)
            .accessibilityLabel("Insert")
            .accessibilityIdentifier("insert-plus")
            .popover(isPresented: $showShapes) { shapePopover }
        }
    }

    @ViewBuilder private var mediaItems: some View {
        Button("Choose Photo", systemImage: "photo") { showPhotos = true }
        Button("Take Photo", systemImage: "camera") { showCamera = true }
            .disabled(!UIImagePickerController.isSourceTypeAvailable(.camera))
        Button("Choose File", systemImage: "folder") { showFiles = true }
        Button("Paste", systemImage: "doc.on.clipboard") { session.paste() }.disabled(!session.canPaste)
        Divider()
        Button("Shapes and Symbols…", systemImage: "star.square.on.square") { showLibrary = true }
    }

    private var shapePopover: some View {
        ShapeGrid { kind in
            showShapes = false
            session.addShape(kind)
        } more: {
            showShapes = false
            showLibrary = true
        }
    }

    private func toolButton(_ symbol: String, _ label: String, on: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 19, weight: .regular))
                .frame(width: 46, height: 44)
                .foregroundStyle(on ? Color.white : .primary)
                .background(on ? Color.accentColor : .clear, in: Capsule())
        }
        .accessibilityLabel(label)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    // MARK: Undo and more

    private var undoCapsule: some View {
        HStack(spacing: 0) {
            Button { session.undo() } label: {
                Image(systemName: "arrow.uturn.backward").font(.system(size: 18, weight: .medium)).frame(width: 44, height: 44)
            }
            .disabled(!session.canUndo)
            .contextMenu {
                ForEach(Array(session.undoNames.enumerated()), id: \.offset) { i, name in
                    Button("Undo \(name.hasPrefix("Typing") ? "Typing" : name)") { session.undo(steps: i + 1) }
                }
            }
            .accessibilityLabel("Undo")
            .accessibilityIdentifier("undo-button")
            Button { session.redo() } label: {
                Image(systemName: "arrow.uturn.forward").font(.system(size: 18, weight: .medium)).frame(width: 44, height: 44)
            }
            .disabled(!session.canRedo)
            .accessibilityLabel("Redo")
            .accessibilityIdentifier("redo-button")
            moreMenu
        }
        .padding(.horizontal, 4)
        .foregroundStyle(.primary)
        .glassEffect(.regular, in: Capsule())
    }

    private var moreMenu: some View {
        Menu {
            Button("Select", systemImage: "checkmark.circle") { session.clearSelection(); session.selecting = true }
            Button("Select All", systemImage: "square.dashed") { session.selectAll() }
            Button("Paste", systemImage: "doc.on.clipboard") { session.paste() }.disabled(!session.canPaste)
            Divider()
            Button("Add Scene", systemImage: "star") { session.addScene() }
            Button("Paper…", systemImage: "doc.richtext") { showPaper = true }
            Menu("Alignment", systemImage: "squareshape.split.2x2.dotted") {
                Toggle("Snap to Grid", isOn: $snapToGrid)
                Toggle("Center Guides", isOn: $centerGuides)
                Toggle("Edge Guides", isOn: $edgeGuides)
                Toggle("Spacing Guides", isOn: $spacingGuides)
            }
            Toggle(isOn: $fingerDraws) { Label("Draw with Finger", systemImage: "hand.draw") }
            Divider()
            exportMenu
        } label: {
            Image(systemName: "ellipsis").font(.system(size: 18, weight: .medium)).frame(width: 44, height: 44)
        }
        .accessibilityLabel("More")
        .accessibilityIdentifier("more-menu")
    }

    // MARK: Zoom and Scenes

    private static let zoomLevels: [CGFloat] = [4, 2, 1.5, 1, 0.75, 0.5, 0.25, 0.1]

    private var zoomCapsule: some View {
        HStack(spacing: 0) {
            Menu {
                Button("Zoom to Fit Content", systemImage: "arrow.up.left.and.arrow.down.right") {
                    if let r = session.contentBounds { ink.show(rect: r, animated: true, maxZoom: 4) }
                }
                .disabled(session.contentBounds == nil)
                Divider()
                ForEach(Self.zoomLevels, id: \.self) { z in
                    Button("\(Int(z * 100))%", systemImage: abs(ink.zoomScale - z) < 0.005 ? "checkmark" : "") { ink.setZoom(z, animated: true) }
                }
            } label: {
                Text("\(Int((ink.zoomScale * 100).rounded()))%")
                    .font(.system(size: 16, weight: .medium)).monospacedDigit()
                    .frame(minWidth: 64).frame(height: 44)
            }
            .accessibilityLabel("Zoom")
            .accessibilityIdentifier("zoom-menu")
            Divider().frame(height: 22)
            Button { step(-1) } label: { Image(systemName: "chevron.left").frame(width: 38, height: 44) }
                .disabled(session.meta.scenes.isEmpty)
                .accessibilityLabel("Previous Scene")
            Button { showScenes = true } label: { Image(systemName: "list.bullet").frame(width: 38, height: 44) }
                .accessibilityLabel("Scenes")
                .accessibilityIdentifier("scenes-button")
                .popover(isPresented: $showScenes) { ScenesList(session: session, export: { showScenes = false; exportScenes() }) }
            Button { step(1) } label: { Image(systemName: "chevron.right").frame(width: 38, height: 44) }
                .disabled(session.meta.scenes.isEmpty)
                .accessibilityLabel("Next Scene")
        }
        .font(.system(size: 16, weight: .medium))
        .padding(.horizontal, 6)
        .foregroundStyle(.primary)
        .glassEffect(.regular, in: Capsule())
    }

    @State private var sceneIndex = -1

    private func step(_ d: Int) {
        let scenes = session.meta.scenes
        guard !scenes.isEmpty else { return }
        sceneIndex = (sceneIndex + d + scenes.count) % scenes.count
        session.show(scenes[sceneIndex])
    }

    // MARK: Bottom right: paper, mic and Send

    private var bottomRight: some View {
        HStack(spacing: 12) {
            Button { showPaper = true } label: {
                Image(systemName: paper.style.symbol).font(.system(size: 18, weight: .medium)).frame(width: 52, height: 52)
            }
            .foregroundStyle(.primary)
            .glassEffect(.regular.interactive(), in: Circle())
            .accessibilityLabel("Paper")
            .accessibilityIdentifier("paper-button")
            .popover(isPresented: $showPaper) {
                PaperPicker(paper: Binding(get: { session.meta.paper }, set: { p in session.updateMeta { $0.paper = p } }))
            }
            VoiceSendDock(voice: voice, pending: link.pendingSends, lastSend: session.lastSendOK, onFail: { session.say($0) }) { said, words in
                session.send(trigger: "voice", said: said, words: words)
            } send: {
                session.send(trigger: "button")
            }
        }
    }

    @ViewBuilder private var messages: some View {
        VStack(spacing: 10) {
            if voice.state != .idle {
                Text(voice.partial.isEmpty ? "Listening…" : voice.partial)
                    .font(.title3)
                    .foregroundStyle(voice.partial.isEmpty ? .secondary : .primary)
                    .padding(.horizontal, 18).padding(.vertical, 12)
                    .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 20))
                    .frame(maxWidth: 560)
                    .accessibilityIdentifier("voice-partial")
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            if let notice = session.notice {
                Text(notice)
                    .font(.callout)
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    .glassEffect(.regular, in: Capsule())
                    .transition(.opacity)
                    .accessibilityIdentifier("send-notice")
            }
        }
        .animation(.spring(duration: 0.3), value: voice.state)
        .animation(.easeInOut, value: session.notice)
    }
}

private struct ExportItem: Identifiable {
    let url: URL
    var id: URL { url }
}

// MARK: Layers

/// The paper's pattern, following the ink's viewport.
struct PaperLayer: View {
    let ink: InkCanvasController
    let paper: Paper
    let dark: Bool

    var body: some View {
        let z = ink.zoomScale, o = ink.contentOffset
        Canvas { ctx, size in
            PaperDrawing.draw(paper, dark: dark, in: ctx, size: size, origin: CGPoint(x: o.x / z, y: o.y / z), zoom: z)
        }
        .allowsHitTesting(false)
    }
}

/// Every object under the ink, scaled with the board.
struct ObjectsLayer: View {
    let session: BoardSession
    let darkPaper: Bool

    var body: some View {
        let ink = session.ink
        let z = ink.zoomScale, o = ink.contentOffset
        let visible = ink.visibleRect.insetBy(dx: -300, dy: -300)
        ZStack(alignment: .topLeading) {
            Canvas { ctx, _ in
                var c = ctx
                c.translateBy(x: -o.x, y: -o.y)
                c.scaleBy(x: z, y: z)
                for obj in session.objects where obj.isConnector {
                    ConnectorGeometry.draw(obj, in: &c, ink: darkPaper ? .white : Color(red: 0.11, green: 0.11, blue: 0.12), selected: session.selection.contains(obj.id))
                }
            }
            ForEach(session.objects.filter { !$0.isConnector && $0.frame.intersects(visible) }) { obj in
                ObjectContent(object: obj, files: session.files, darkPaper: darkPaper, hideText: session.editing == obj.id)
                    .frame(width: obj.frame.width, height: obj.frame.height)
                    .scaleEffect(z)
                    .position(x: obj.frame.midX * z - o.x, y: obj.frame.midY * z - o.y)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .allowsHitTesting(false)
        .environment(\.colorScheme, darkPaper ? .dark : .light)
    }
}

// MARK: Camera and sharing

struct CameraPicker: UIViewControllerRepresentable {
    let picked: (Data) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let vc = UIImagePickerController()
        vc.sourceType = .camera
        vc.delegate = context.coordinator
        return vc
    }

    func updateUIViewController(_ vc: UIImagePickerController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ p: CameraPicker) { parent = p }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage, let data = image.jpegData(compressionQuality: 0.9) { parent.picked(data) }
            parent.dismiss()
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
    }
}

struct ShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}
