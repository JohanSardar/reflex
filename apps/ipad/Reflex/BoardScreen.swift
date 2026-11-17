import AVFoundation
import PencilKit
import PhotosUI
import ReflexInput
import ReflexLink
import SwiftUI
import UniformTypeIdentifiers

/// One board: paper, objects, ink and the chrome around them.
struct BoardScreen: View {
    let session: BoardSession
    let link: LinkSync
    let voice: VoiceCapture
    let recordings: RecordingStore
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
    @State private var showRecordings = false
    @State private var player = RecordingPlayer()
    @State private var renaming = false
    @State private var draftTitle = ""
    @State private var exportURL: URL?
    @State private var screen: CGSize = .zero
    @State private var frame: CGRect = .zero
    @FocusState private var titleFocused: Bool

    private var ink: InkCanvasController { session.ink }
    private var paper: Paper { session.meta.paper }
    private var darkPaper: Bool { paper.tint.isDark(system: scheme == .dark) }

    private var guideSettings: BoardSession.GuideSettings {
        .init(
            snapToGrid: snapToGrid, center: centerGuides, edges: edgeGuides, spacing: spacingGuides,
            grid: paper.spacing.points)
    }

    var body: some View {
        ZStack {
            paper.tint.color(dark: scheme == .dark).ignoresSafeArea()
            PaperLayer(ink: ink, paper: paper, dark: darkPaper).ignoresSafeArea()
            ObjectsLayer(session: session, darkPaper: darkPaper).ignoresSafeArea()
            InkCanvas(controller: ink).ignoresSafeArea()
            ObjectsLayer(session: session, darkPaper: darkPaper, above: true).ignoresSafeArea()
            InteractionLayer(session: session, darkPaper: darkPaper, guides: guideSettings, screen: screen)
                .ignoresSafeArea()
        }
        .onGeometryChange(for: CGRect.self) {
            $0.frame(in: .global)
        } action: {
            screen = $0.size
            frame = $0
        }
        .overlay(alignment: .top) { topBar }
        .overlay(alignment: .bottomLeading) {
            zoomCapsule.padding(.leading, 16).padding(.bottom, max(bottomLift, leadingLift) + 16)
        }
        .overlay(alignment: .bottomTrailing) {
            // Hidden while the keyboard is up: it would sit under or on top of it.
            bottomRight.padding(.trailing, 16 + trailingLift).padding(.bottom, bottomLift + 16)
                .opacity(keyboardTop.isFinite ? 0 : 1).allowsHitTesting(!keyboardTop.isFinite)
                .animation(.easeOut(duration: 0.2), value: keyboardTop.isFinite)
        }
        .overlay(alignment: .bottom) { messages.padding(.bottom, bottomLift + 92) }
        // The keyboard covers the bottom chrome instead of pushing it up.
        .ignoresSafeArea(.keyboard)
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) { note in
            keyboardTop = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect)?.minY ?? .infinity
            keepEditingAboveKeyboard()
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            keyboardTop = .infinity
        }
        .onChange(of: session.editing) { old, new in
            keepEditingAboveKeyboard()
            if new == nil, old != nil, session.paletteAfterEditing {
                session.paletteAfterEditing = false
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                    ink.setPickerVisible(true)
                    ink.pickInkTool()
                }
            }
        }
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
        .sheet(item: Binding(get: { exportURL.map(ExportItem.init) }, set: { if $0 == nil { exportURL = nil } })) {
            item in
            ShareSheet(url: item.url)
        }
    }

    private func applyPaperStyle() {
        ink.canvasView.overrideUserInterfaceStyle = darkPaper ? .dark : .light
        ink.toolPicker.colorUserInterfaceStyle = darkPaper ? .dark : .light
    }

    // MARK: Typing above the keyboard

    @State private var keyboardTop: CGFloat = .infinity

    /// Scrolls the board so the text being typed sits above the keyboard, as Freeform does.
    private func keepEditingAboveKeyboard() {
        guard keyboardTop.isFinite, let id = session.editing, let obj = session.object(id) else { return }
        let z = ink.zoomScale
        let o = ink.contentOffset
        var r = CGRect(
            x: obj.frame.minX * z - o.x, y: obj.frame.minY * z - o.y, width: obj.frame.width * z,
            height: obj.frame.height * z)
        if obj.kind == .table, let cell = session.editingCell, let t = obj.table, t.rows > 0 {
            let rh = r.height / CGFloat(t.rows)
            r = CGRect(x: r.minX, y: r.minY + CGFloat(cell.row) * rh, width: r.width, height: rh)
        }
        // The keyboard's top in this view's space (the board fills the screen).
        let limit = keyboardTop - 24
        guard r.maxY > limit else { return }
        // Bring the bottom above the keyboard, but never push the top under the top bar.
        let dy = min(r.maxY - limit, max(0, r.minY - 100))
        if dy > 1 { ink.scroll(by: CGPoint(x: 0, y: dy)) }
    }

    // MARK: Lifting the chrome above the docked palette

    private var bottomLift: CGFloat {
        let r = ink.pickerObscured
        guard ink.pickerVisible, !r.isNull, screen.height > 0, r.width > screen.width * 0.4,
            r.minY > frame.height * 0.55
        else { return 0 }
        return max(0, frame.maxY - r.minY + 4)
    }

    /// A minimized (floating) palette parked over the bottom-left capsule pushes the capsule above it.
    private var leadingLift: CGFloat {
        let r = ink.pickerObscured
        guard ink.pickerVisible, !r.isNull, bottomLift == 0, screen.height > 0 else { return 0 }
        let capsule = CGRect(x: frame.minX, y: frame.maxY - 16 - 52, width: 340, height: 68)
        guard r.intersects(capsule) else { return 0 }
        return max(0, frame.maxY - r.minY + 4)
    }

    private var trailingLift: CGFloat {
        let r = ink.pickerObscured
        guard ink.pickerVisible, !r.isNull, screen.width > 0, r.minX > screen.width * 0.6, r.maxY > screen.height - 110
        else { return 0 }
        return max(0, frame.maxX - r.minX)
    }

    // MARK: Top bar

    private var foldInsertTools: Bool { screen.width < 900 || (screen.width < 1150 && session.meta.title.count > 22) }

    private var topBar: some View {
        HStack(spacing: 10) {
            GlassEffectContainer(spacing: 8) {
                HStack(spacing: 8) {
                    Button(action: onBack) {
                        Image(systemName: "chevron.left").font(.system(size: 18, weight: .semibold)).frame(
                            width: 44, height: 44)
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
            StatusCapsule(link: link, action: onStatus)
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
                Button(
                    session.meta.favorite ? "Unfavorite" : "Favorite",
                    systemImage: session.meta.favorite ? "heart.slash" : "heart"
                ) {
                    library.toggleFavorite(session.id)
                }
                Menu("Move to", systemImage: "folder") {
                    Button("No Folder", systemImage: session.meta.folder == nil ? "checkmark" : "tray") {
                        library.move([session.id], to: nil)
                    }
                    ForEach(library.folders) { f in
                        Button(library.path(f.id), systemImage: session.meta.folder == f.id ? "checkmark" : "folder") {
                            library.move([session.id], to: f.id)
                        }
                    }
                }
                Divider()
                Button("Paper…", systemImage: "doc.richtext") { showPaper = true }
                exportMenu
            } label: {
                HStack(spacing: 6) {
                    if session.meta.favorite {
                        Image(systemName: "heart.fill").font(.system(size: 13)).foregroundStyle(.pink)
                    }
                    Text(shortTitle).font(.system(size: 17, weight: .semibold)).lineLimit(1)
                    Image(systemName: "chevron.down.circle.fill").font(.system(size: 15)).symbolRenderingMode(
                        .hierarchical
                    ).foregroundStyle(.secondary)
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
        // When the insert tools fold into "+", the title gets their room.
        let limit =
            foldInsertTools ? (screen.width < 700 ? 22 : 40) : (screen.width < 900 ? 18 : screen.width > 1150 ? 44 : 30)
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
        exportURL = BoardRenderer.pdf(
            pages: [r], drawing: ink.drawing, objects: session.objects, files: session.files, paper: paper,
            name: session.meta.title)
    }

    private func exportScenes() {
        session.ink.flush()
        exportURL = BoardRenderer.pdf(
            pages: session.meta.scenes.map(\.rect), drawing: ink.drawing, objects: session.objects,
            files: session.files, paper: paper, name: "\(session.meta.title) Scenes")
    }

    // MARK: Insert tools

    private var insertCapsule: some View {
        HStack(spacing: 2) {
            toolButton("pencil.tip.crop.circle", "Drawing Tools", on: ink.pickerVisible) {
                ink.setPickerVisible(!ink.pickerVisible)
            }
            .accessibilityIdentifier("tool-pen")
            toolButton("character.textbox", "Text") { session.addText() }.accessibilityIdentifier("insert-text")
            toolButton("square.on.circle", "Shape") { showShapes = true }
                .accessibilityIdentifier("insert-shape")
                .popover(isPresented: $showShapes) { shapePopover }
            toolButton("note.text", "Sticky Note") { session.addSticky() }.accessibilityIdentifier("insert-sticky")
            toolButton("tablecells", "Table") { session.addTable() }.accessibilityIdentifier("insert-table")
            Menu {
                mediaItems
            } label: {
                Image(systemName: "photo.on.rectangle.angled").font(.system(size: 19, weight: .regular)).frame(
                    width: 46, height: 44)
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
            Button {
                ink.setPickerVisible(!ink.pickerVisible)
            } label: {
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
            .disabled(!Camera.available)
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

    private func toolButton(_ symbol: String, _ label: String, on: Bool = false, action: @escaping () -> Void)
        -> some View
    {
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
            Button {
                session.undo()
            } label: {
                Image(systemName: "arrow.uturn.backward").font(.system(size: 18, weight: .medium)).frame(
                    width: 44, height: 44
                )
                .opacity(session.canUndo ? 1 : 0.3)
            }
            .disabled(!session.canUndo)
            .contextMenu {
                ForEach(Array(session.undoNames.enumerated()), id: \.offset) { i, name in
                    Button("Undo \(name.hasPrefix("Typing") ? "Typing" : name)") { session.undo(steps: i + 1) }
                }
            }
            .accessibilityLabel("Undo")
            .accessibilityIdentifier("undo-button")
            Button {
                session.redo()
            } label: {
                Image(systemName: "arrow.uturn.forward").font(.system(size: 18, weight: .medium)).frame(
                    width: 44, height: 44
                )
                .opacity(session.canRedo ? 1 : 0.3)
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
            Button("Select", systemImage: "checkmark.circle") {
                session.clearSelection()
                session.selecting = true
            }
            Button("Select All", systemImage: "square.dashed") { session.selectAll() }
            Button("Paste", systemImage: "doc.on.clipboard") { session.paste() }.disabled(!session.canPaste)
            Divider()
            Button("Add Scene", systemImage: "star") { session.addScene() }
            Menu("Alignment", systemImage: "squareshape.split.2x2.dotted") {
                Toggle("Snap to Grid", isOn: $snapToGrid)
                Toggle("Center Guides", isOn: $centerGuides)
                Toggle("Edge Guides", isOn: $edgeGuides)
                Toggle("Spacing Guides", isOn: $spacingGuides)
            }
            Toggle(isOn: $fingerDraws) { Label("Draw with Finger", systemImage: "hand.draw") }
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
                    Button("\(Int(z * 100))%", systemImage: abs(ink.zoomScale - z) < 0.005 ? "checkmark" : "") {
                        ink.setZoom(z, animated: true)
                    }
                }
            } label: {
                Text("\(Int((ink.zoomScale * 100).rounded()))%")
                    .font(.system(size: 16, weight: .medium)).monospacedDigit()
                    .frame(minWidth: 64).frame(height: 44)
            }
            .accessibilityLabel("Zoom")
            .accessibilityIdentifier("zoom-menu")
            Divider().frame(height: 22)
            Button {
                step(-1)
            } label: {
                Image(systemName: "chevron.left").frame(width: 38, height: 44)
            }
            .disabled(session.meta.scenes.isEmpty)
            .accessibilityLabel("Previous Scene")
            Button {
                showScenes = true
            } label: {
                Image(systemName: "list.bullet").frame(width: 38, height: 44)
            }
            .accessibilityLabel("Scenes")
            .accessibilityIdentifier("scenes-button")
            .popover(isPresented: $showScenes) {
                ScenesList(
                    session: session,
                    export: {
                        showScenes = false
                        exportScenes()
                    })
            }
            Button {
                step(1)
            } label: {
                Image(systemName: "chevron.right").frame(width: 38, height: 44)
            }
            .disabled(session.meta.scenes.isEmpty)
            .accessibilityLabel("Next Scene")
            Divider().frame(height: 22)
            Button {
                showPaper = true
            } label: {
                Image(systemName: paper.style.symbol).frame(width: 44, height: 44)
            }
            .accessibilityLabel("Paper")
            .accessibilityIdentifier("paper-button")
            .popover(isPresented: $showPaper) {
                PaperPicker(
                    paper: Binding(get: { session.meta.paper }, set: { p in session.updateMeta { $0.paper = p } })
                )
                .preferredColorScheme(darkPaper ? .dark : .light)
            }
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

    // MARK: Bottom right: mic and Send

    private var bottomRight: some View {
        HStack(spacing: 10) {
            if !voice.holding && voice.state == .idle {
                RecordingsButton(store: recordings) { showRecordings.toggle() }
                    .popover(isPresented: $showRecordings, arrowEdge: .bottom) {
                        RecordingsPanel(
                            store: recordings, player: player, canSend: link.destinationKey != nil,
                            send: sendAgain, done: { showRecordings = false }
                        )
                        .onAppear { recordings.refresh(stillPending: link.isPending) }
                    }
                    .transition(.scale.combined(with: .opacity))
            }
            VoiceSendDock(
                voice: voice, pending: link.pendingSends, lastSend: session.lastSendOK,
                preparing: session.preparingSends > 0,
                paired: link.destinationKey != nil, onFail: { session.say($0) },
                recordTo: {
                    showRecordings = false
                    player.stop()
                    return recordings.begin()
                }
            ) { take, cutOff in
                released(take, cutOff: cutOff)
            } send: {
                session.send(trigger: "button")
            }
        }
        .animation(.spring(duration: 0.35, bounce: 0.25), value: voice.holding || voice.state != .idle)
        .onChange(of: link.pendingSends, initial: true) { _, _ in recordings.refresh(stillPending: link.isPending) }
    }

    /// A hold ended. Its recording is saved first; then, if it was released and words were heard, it goes out
    /// in a Send with the board, as voice always has.
    private func released(_ take: VoiceCapture.Take, cutOff: Bool) {
        // A tap, not a hold: nothing to keep.
        if !cutOff, take.duration < 0.6, take.said.isEmpty {
            recordings.discard(take)
            session.say("Didn't catch that. Hold the mic and talk, then let go.")
            return
        }
        let r = recordings.finish(take, cutOff: cutOff)
        if cutOff {
            recordings.noteUnsent()
            session.say("Recording cut off. It's saved in Recordings.")
        } else if r.heardNothing {
            recordings.noteUnsent()
            session.say("Didn't catch any words. The audio is saved in Recordings.")
        } else {
            send(r)
            if link.destinationKey == nil { recordings.noteUnsent() }
        }
    }

    private func sendAgain(_ r: Recording) {
        showRecordings = false
        send(r)
    }

    private func send(_ r: Recording) {
        let agents = link.agents.values.filter { $0.status == "approved" }.map(\.name).sorted()
        session.send(trigger: "voice", said: r.said, words: r.sendWords) { send in
            recordings.queued(r.id, send: send, to: agents)
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
                HStack(spacing: 12) {
                    Text(notice).font(.callout)
                    if session.noticeOffersPairing {
                        Button("Pair") {
                            session.notice = nil
                            onStatus()
                        }
                        .buttonStyle(.borderedProminent).controlSize(.small)
                        .accessibilityIdentifier("notice-pair")
                    }
                }
                .padding(.leading, 16).padding(.trailing, session.noticeOffersPairing ? 8 : 16).padding(
                    .vertical, session.noticeOffersPairing ? 6 : 10
                )
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
        let z = ink.zoomScale
        let o = ink.contentOffset
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
    /// Which side of the ink: the objects under it, or the ones brought in front.
    var above = false

    var body: some View {
        let ink = session.ink
        let z = ink.zoomScale
        let o = ink.contentOffset
        let size = ink.viewSize == .zero ? CGSize(width: 2000, height: 2000) : ink.viewSize
        let visible = CGRect(x: o.x / z, y: o.y / z, width: size.width / z, height: size.height / z).insetBy(
            dx: -300, dy: -300)
        ZStack(alignment: .topLeading) {
            Canvas { ctx, _ in
                var c = ctx
                c.translateBy(x: -o.x, y: -o.y)
                c.scaleBy(x: z, y: z)
                for obj in session.objects where obj.isConnector && obj.isAboveInk == above {
                    ConnectorGeometry.draw(
                        obj, in: &c, ink: darkPaper ? .white : Color(red: 0.11, green: 0.11, blue: 0.12),
                        selected: session.selection.contains(obj.id))
                }
            }
            ForEach(
                session.objects.filter { !$0.isConnector && $0.isAboveInk == above && $0.frame.intersects(visible) }
            ) { obj in
                ObjectContent(
                    object: obj, files: session.files, darkPaper: darkPaper, hideText: session.editing == obj.id,
                    editingCell: session.editing == obj.id ? session.editingCell.map { [$0.row, $0.col] } : nil
                )
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
        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            if let image = info[.originalImage] as? UIImage, let data = image.jpegData(compressionQuality: 0.9) {
                parent.picked(data)
            }
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

/// Whether this device can take a photo: a camera the picker can use and that really exists.
enum Camera {
    static var available: Bool {
        UIImagePickerController.isSourceTypeAvailable(.camera) && AVCaptureDevice.default(for: .video) != nil
    }
}
