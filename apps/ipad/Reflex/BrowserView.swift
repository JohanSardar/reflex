import ReflexLink
import SwiftUI

/// The home screen: All Boards, Recents, Favorites and folders, as a grid or a list.
struct BrowserView: View {
    let library: BoardLibrary
    let link: LinkSync
    let open: (String) -> Void
    let onStatus: () -> Void

    @State private var section: BoardSection? = .all
    @State private var query = ""
    @AppStorage("browserList") private var listLayout = false
    @AppStorage("browserSort") private var sortRaw = BoardSort.date.rawValue
    @AppStorage("browserAscending") private var ascending = false
    @AppStorage("browserGroups") private var useGroups = false
    @State private var selecting = false
    @State private var picked: Set<String> = []
    @State private var renaming: String?
    @State private var renamingFolder: String?
    @State private var newFolderParent: String??
    @State private var draftName = ""
    @State private var confirmDelete: [String]?
    @State private var columns = NavigationSplitViewVisibility.all

    private var sort: BoardSort { BoardSort(rawValue: sortRaw) ?? .date }

    var body: some View {
        NavigationSplitView(columnVisibility: $columns) {
            sidebar
        } detail: {
            NavigationStack { detail }.id(section)
        }
        .alert("Rename Board", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Title", text: $draftName).accessibilityIdentifier("rename-field")
            Button("Cancel", role: .cancel) {}
            Button("Rename") { if let id = renaming { library.rename(id, draftName) } }
        }
        .alert("Rename Folder", isPresented: Binding(get: { renamingFolder != nil }, set: { if !$0 { renamingFolder = nil } })) {
            TextField("Name", text: $draftName).accessibilityIdentifier("rename-folder-field")
            Button("Cancel", role: .cancel) {}
            Button("Rename") { if let id = renamingFolder { library.renameFolder(id, draftName) } }
        }
        .alert("New Folder", isPresented: Binding(get: { newFolderParent != nil }, set: { if !$0 { newFolderParent = nil } })) {
            TextField("Name", text: $draftName).accessibilityIdentifier("folder-name-field")
            Button("Cancel", role: .cancel) {}
            Button("Create") {
                if case .some(let parent) = newFolderParent {
                    let f = library.createFolder(draftName, parent: parent)
                    section = .folder(f.id)
                }
            }
        } message: { Text("Enter a name for this folder.") }
        .confirmationDialog(confirmDelete?.count == 1 ? "Delete this board?" : "Delete \(confirmDelete?.count ?? 0) boards?",
                            isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } }), titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                if let ids = confirmDelete { library.delete(ids); picked.subtract(ids) }
            }
        } message: { Text("It is moved out of your boards and kept in Reflex's Trash on this iPad.") }
    }

    // MARK: Sidebar

    private var sidebar: some View {
        List(selection: $section) {
            row("All Boards", "square.on.square", .blue, .all)
            row("Recents", "clock", .orange, .recents)
            row("Favorites", "heart.fill", .pink, .favorites)
            Section("Folders") {
                ForEach(library.children(of: nil)) { f in folderRows(f, depth: 0) }
                Button { draftName = ""; newFolderParent = .some(nil) } label: {
                    Label("New Folder", systemImage: "folder.badge.plus")
                }
                .accessibilityIdentifier("new-folder")
            }
        }
        .navigationTitle("Reflex")
    }

    private func row(_ title: String, _ symbol: String, _ color: Color, _ s: BoardSection) -> some View {
        Label {
            HStack {
                Text(title)
                Spacer()
                Text("\(library.count(s))").foregroundStyle(.secondary).monospacedDigit()
            }
        } icon: {
            Image(systemName: symbol).foregroundStyle(.white).font(.system(size: 13, weight: .semibold))
                .frame(width: 28, height: 28).background(color.gradient, in: Circle())
        }
        .tag(s)
        .accessibilityIdentifier("sidebar-\(title)")
    }

    private func folderRows(_ f: BoardFolder, depth: Int) -> AnyView {
        AnyView(Group {
            Label {
                HStack {
                    Text(f.name)
                    Spacer()
                    Text("\(library.count(.folder(f.id)))").foregroundStyle(.secondary).monospacedDigit()
                }
            } icon: { Image(systemName: "folder").foregroundStyle(Color.accentColor) }
                .padding(.leading, CGFloat(depth) * 18)
                .tag(BoardSection.folder(f.id))
                .contextMenu { folderMenu(f) }
                .accessibilityIdentifier("folder-\(f.name)")
            ForEach(library.children(of: f.id)) { child in folderRows(child, depth: depth + 1) }
        })
    }

    @ViewBuilder private func folderMenu(_ f: BoardFolder) -> some View {
        Button("Rename", systemImage: "pencil") { draftName = f.name; renamingFolder = f.id }
        Button("New Folder", systemImage: "folder.badge.plus") { draftName = ""; newFolderParent = .some(f.id) }
        Menu("Move to", systemImage: "folder") {
            Button("Top Level") { library.moveFolder(f.id, to: nil) }
            ForEach(library.folders.filter { $0.id != f.id && !library.descendants(of: f.id).contains($0.id) }) { other in
                Button(library.path(other.id)) { library.moveFolder(f.id, to: other.id) }
            }
        }
        Button("Delete Folder", systemImage: "trash", role: .destructive) {
            if section == .folder(f.id) { section = .all }
            library.deleteFolder(f.id)
        }
    }

    // MARK: Detail

    private var current: BoardSection { section ?? .all }

    private var title: String {
        switch current {
        case .all: "All Boards"
        case .recents: "Recents"
        case .favorites: "Favorites"
        case .folder(let id): library.folder(id)?.name ?? "Folder"
        }
    }

    private var shown: [BoardMeta] {
        var list = library.boards(in: current)
        if !query.isEmpty {
            list = library.all.filter { $0.title.localizedCaseInsensitiveContains(query) || $0.text.localizedCaseInsensitiveContains(query) }
        }
        if current == .recents && query.isEmpty { return list }
        switch sort {
        case .date: list.sort { ascending ? $0.modified < $1.modified : $0.modified > $1.modified }
        case .name: list.sort { ascending == ($0.title.localizedStandardCompare($1.title) == .orderedAscending) }
        }
        return list
    }

    private var groups: [(String, [BoardMeta])] {
        let list = shown
        guard (useGroups && sort == .date) || current == .recents, query.isEmpty else { return [("", list)] }
        let cal = Calendar.current
        var out: [(String, [BoardMeta])] = []
        for b in list {
            let d = current == .recents ? (b.opened ?? b.modified) : b.modified
            let name: String
            if cal.isDateInToday(d) { name = "Today" }
            else if cal.isDateInYesterday(d) { name = "Yesterday" }
            else if let days = cal.dateComponents([.day], from: d, to: Date()).day, days < 7 { name = "Previous 7 Days" }
            else if let days = cal.dateComponents([.day], from: d, to: Date()).day, days < 30 { name = "Previous 30 Days" }
            else { name = d.formatted(.dateTime.month(.wide).year()) }
            if out.last?.0 == name { out[out.count - 1].1.append(b) } else { out.append((name, [b])) }
        }
        return out
    }

    private var detail: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 4) {
                Text("\(shown.count) \(shown.count == 1 ? "Board" : "Boards")")
                    .font(.title3).foregroundStyle(.secondary)
                    .padding(.horizontal, 24)
                ForEach(groups, id: \.0) { name, boards in
                    if !name.isEmpty {
                        Text(name).font(.headline).padding(.horizontal, 24).padding(.top, 18)
                    }
                    if listLayout { listRows(boards) } else { grid(boards) }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, 90)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .overlay { emptyState.frame(maxWidth: 480).frame(maxWidth: .infinity, maxHeight: .infinity) }
        .navigationTitle(query.isEmpty ? title : "Search")
        .navigationBarTitleDisplayMode(.large)
        .searchable(text: $query, placement: .toolbar, prompt: "Search titles and text")
        .toolbar { detailToolbar }
        .safeAreaInset(edge: .bottom) { if selecting { selectBar } }
        .animation(.default, value: listLayout)
        .animation(.default, value: shown.map(\.id))
    }

    @ViewBuilder private var emptyState: some View {
        if shown.isEmpty {
            if !query.isEmpty {
                ContentUnavailableView.search(text: query)
            } else {
                switch current {
                case .favorites:
                    ContentUnavailableView("No Favorites", systemImage: "heart", description: Text("Boards you favorite show up here."))
                case .recents:
                    ContentUnavailableView("No Recent Boards", systemImage: "clock", description: Text("Boards you open show up here."))
                default:
                    ContentUnavailableView {
                        Label("No Boards", systemImage: "square.on.square")
                    } description: {
                        Text("Start a board to write, sketch and Send to your agents.")
                    } actions: {
                        Button("New Board") { newBoard() }.buttonStyle(.glassProminent)
                    }
                }
            }
        }
    }

    @ToolbarContentBuilder private var detailToolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarTrailing) {
            if selecting {
                Button(picked.count == shown.count ? "Deselect All" : "Select All") {
                    picked = picked.count == shown.count ? [] : Set(shown.map(\.id))
                }
                Button("Done") { selecting = false; picked = [] }.fontWeight(.semibold)
            } else {
                Button { newBoard() } label: { Image(systemName: "square.and.pencil") }
                    .accessibilityLabel("New Board")
                    .accessibilityIdentifier("new-board")
                Menu {
                    Picker("Layout", selection: $listLayout) {
                        Label("Icons", systemImage: "square.grid.2x2").tag(false)
                        Label("List", systemImage: "list.bullet").tag(true)
                    }
                } label: { Image(systemName: listLayout ? "list.bullet" : "square.grid.2x2") }
                    .accessibilityLabel("Layout")
                    .accessibilityIdentifier("layout-menu")
                Menu {
                    Button("Select", systemImage: "checkmark.circle") { selecting = true }
                    Divider()
                    Menu("Sort By", systemImage: "arrow.up.arrow.down") {
                        sortButton(.date, "Date Edited")
                        sortButton(.name, "Name")
                    }
                    Toggle(isOn: $useGroups) { Label("Use Groups", systemImage: "rectangle.grid.1x2") }
                        .disabled(sort != .date)
                } label: { Image(systemName: "ellipsis") }
                    .accessibilityLabel("More")
                    .accessibilityIdentifier("browser-more")
            }
        }
        // The connection lives in the top-right corner, as it does on a board.
        ToolbarItem(placement: .topBarTrailing) {
            StatusCapsule(link: link, compact: true, action: onStatus).fixedSize()
        }
        .sharedBackgroundVisibility(.hidden)
    }

    private func sortButton(_ s: BoardSort, _ title: String) -> some View {
        Button {
            if sort == s { ascending.toggle() } else { sortRaw = s.rawValue; ascending = s == .name }
        } label: {
            if sort == s { Label(title, systemImage: ascending ? "chevron.up" : "chevron.down") } else { Text(title) }
        }
    }

    private var selectBar: some View {
        HStack(spacing: 24) {
            Text(picked.isEmpty ? "Select boards" : "\(picked.count) selected").foregroundStyle(.secondary)
            Spacer()
            Menu {
                Button("No Folder") { library.move(Array(picked), to: nil) }
                ForEach(library.folders) { f in Button(library.path(f.id)) { library.move(Array(picked), to: f.id) } }
            } label: { Label("Move", systemImage: "folder") }
                .disabled(picked.isEmpty)
            Button { for id in picked { library.duplicate(id) } } label: { Label("Duplicate", systemImage: "plus.square.on.square") }
                .disabled(picked.isEmpty)
            Button(role: .destructive) { confirmDelete = Array(picked) } label: { Label("Delete", systemImage: "trash") }
                .disabled(picked.isEmpty)
                .accessibilityIdentifier("select-delete")
        }
        .padding(.horizontal, 24).padding(.vertical, 14)
        .glassEffect(.regular, in: Capsule())
        .padding(.horizontal, 24).padding(.bottom, 12)
    }

    private func newBoard() {
        var folder: String?
        if case .folder(let f) = current { folder = f }
        open(library.create(in: folder))
    }

    // MARK: Cards

    /// Why a board turned up in a search: the line of its text that holds the words, when
    /// the title alone doesn't.
    private func matchLine(_ b: BoardMeta) -> String? {
        guard !query.isEmpty, !b.title.localizedCaseInsensitiveContains(query) else { return nil }
        guard let line = b.text.split(separator: "\n").first(where: { $0.localizedCaseInsensitiveContains(query) }) else { return nil }
        let s = String(line).trimmingCharacters(in: .whitespaces)
        guard s.count > 42, let r = s.range(of: query, options: .caseInsensitive) else { return "“\(s)”" }
        let start = s.index(r.lowerBound, offsetBy: -14, limitedBy: s.startIndex) ?? s.startIndex
        let end = s.index(start, offsetBy: 42, limitedBy: s.endIndex) ?? s.endIndex
        return "“" + (start > s.startIndex ? "…" : "") + s[start ..< end] + (end < s.endIndex ? "…" : "") + "”"
    }

    private func grid(_ boards: [BoardMeta]) -> some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 200, maximum: 400), spacing: 20)], spacing: 22) {
            ForEach(boards) { b in
                BoardCard(meta: b, library: library, folderName: library.folder(b.folder)?.name, selecting: selecting, picked: picked.contains(b.id),
                          match: matchLine(b))
                    .onTapGesture { tapped(b.id) }
                    .contextMenu { boardMenu(b) } preview: {
                        BoardThumbnail(id: b.id, library: library).frame(width: 420, height: 300)
                    }
            }
        }
        .padding(.horizontal, 24)
        .padding(.top, 12)
    }

    private func listRows(_ boards: [BoardMeta]) -> some View {
        LazyVStack(spacing: 0) {
            ForEach(boards) { b in
                HStack(spacing: 14) {
                    if selecting {
                        Image(systemName: picked.contains(b.id) ? "checkmark.circle.fill" : "circle")
                            .font(.title2).foregroundStyle(picked.contains(b.id) ? Color.accentColor : .secondary)
                    }
                    BoardThumbnail(id: b.id, library: library)
                        .frame(width: 84, height: 60)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(.separator, lineWidth: 0.5))
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            Text(b.title).font(.headline).lineLimit(1)
                            if b.favorite { Image(systemName: "heart.fill").font(.caption).foregroundStyle(.pink) }
                        }
                        if let m = matchLine(b) {
                            Label(m, systemImage: "text.magnifyingglass").font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                        }
                        HStack(spacing: 8) {
                            Text(b.modified.formatted(date: .abbreviated, time: .shortened))
                            if let f = library.folder(b.folder) { Label(f.name, systemImage: "folder").labelStyle(.titleAndIcon) }
                            if b.id.hasPrefix("local-only:") { Text("This iPad only") }
                        }
                        .font(.subheadline).foregroundStyle(.secondary)
                    }
                    Spacer()
                }
                .padding(.horizontal, 24).padding(.vertical, 10)
                .contentShape(Rectangle())
                .onTapGesture { tapped(b.id) }
                .contextMenu { boardMenu(b) }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("board-row-\(b.title)")
                Divider().padding(.leading, 122)
            }
        }
        .padding(.top, 8)
    }

    private func tapped(_ id: String) {
        if selecting {
            if picked.contains(id) { picked.remove(id) } else { picked.insert(id) }
        } else {
            open(id)
        }
    }

    @ViewBuilder private func boardMenu(_ b: BoardMeta) -> some View {
        Button("Open", systemImage: "arrow.up.forward.square") { open(b.id) }
        Button(b.favorite ? "Unfavorite" : "Favorite", systemImage: b.favorite ? "heart.slash" : "heart") { library.toggleFavorite(b.id) }
        Button("Rename", systemImage: "pencil") { draftName = b.title; renaming = b.id }
        Button("Duplicate", systemImage: "plus.square.on.square") { library.duplicate(b.id) }
        Menu("Move to", systemImage: "folder") {
            Button("No Folder", systemImage: b.folder == nil ? "checkmark" : "") { library.move([b.id], to: nil) }
            ForEach(library.folders) { f in
                Button(library.path(f.id), systemImage: b.folder == f.id ? "checkmark" : "folder") { library.move([b.id], to: f.id) }
            }
            Divider()
            Button("New Folder…", systemImage: "folder.badge.plus") { draftName = ""; newFolderParent = .some(nil) }
        }
        Divider()
        Button("Delete", systemImage: "trash", role: .destructive) { confirmDelete = [b.id] }
    }
}

struct BoardCard: View {
    let meta: BoardMeta
    let library: BoardLibrary
    let folderName: String?
    let selecting: Bool
    let picked: Bool
    var match: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            BoardThumbnail(id: meta.id, library: library)
                .frame(height: 150)
                .clipped()
            VStack(alignment: .leading, spacing: 3) {
                Text(meta.title).font(.headline).lineLimit(1)
                if let match {
                    Label(match, systemImage: "text.magnifyingglass").font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                }
                Text(meta.modified.formatted(date: .numeric, time: .shortened)).font(.subheadline).foregroundStyle(.secondary)
                if let folderName {
                    Label(folderName, systemImage: "folder").font(.caption).foregroundStyle(.secondary)
                } else if meta.id.hasPrefix("local-only:") {
                    Text("This iPad only").font(.caption).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 74, alignment: .topLeading)
            .padding(12)
            .background(Color(.secondarySystemBackground))
        }
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(picked ? Color.accentColor : Color(.separator), lineWidth: picked ? 3 : 0.5))
        .overlay(alignment: .topTrailing) {
            if meta.favorite {
                Image(systemName: "heart.fill").font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
                    .frame(width: 26, height: 26).background(.pink, in: Circle()).padding(10)
            }
        }
        .overlay(alignment: .topLeading) {
            if selecting {
                Image(systemName: picked ? "checkmark.circle.fill" : "circle")
                    .font(.title2).symbolRenderingMode(.palette)
                    .foregroundStyle(picked ? Color.white : Color.secondary, picked ? Color.accentColor : Color(.systemBackground).opacity(0.8))
                    .padding(10)
            }
        }
        .shadow(color: .black.opacity(0.06), radius: 6, y: 2)
        .contentShape(RoundedRectangle(cornerRadius: 16))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("board-card-\(meta.title)")
        .accessibilityAddTraits(picked ? [.isSelected, .isButton] : .isButton)
    }
}

struct BoardThumbnail: View {
    let id: String
    let library: BoardLibrary
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let rev = library.thumbnailRevision[id] ?? 0
        let paper = library.boards[id]?.paper ?? Paper()
        let dark = scheme == .dark
        if let image = load(rev, dark: dark) {
            // The board's own paper, as it looks in the current appearance.
            ZStack {
                paper.tint.color(dark: dark)
                Image(uiImage: image).resizable().scaledToFit().padding(10)
            }
        } else {
            // An empty board: a quiet placeholder that follows Light and Dark Mode.
            ZStack {
                Color(.tertiarySystemFill)
                Image(systemName: "scribble.variable").font(.system(size: 36)).foregroundStyle(.tertiary)
            }
        }
    }

    private func load(_ rev: Int, dark: Bool) -> UIImage? {
        _ = rev
        let f = library.files(id)
        if dark, let img = UIImage(contentsOfFile: f.thumbnailDark.path(percentEncoded: false)) { return img }
        return UIImage(contentsOfFile: f.thumbnail.path(percentEncoded: false))
    }
}
