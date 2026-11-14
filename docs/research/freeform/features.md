# Freeform feature checklist

[x] = seen and captured. [ ] = not reachable, with the reason given. Evidence is in `shots/<name>.jpg` or `~/reflex-research/freeform/video/<name>.mp4` (see README).

## Board browser
- [x] All Boards / Recents / Shared / Favorites, each with a count: Sidebar (`browser-home`)
- [x] Hide or show the sidebar (3 → 4 columns): Sidebar toggle (`browser-sidebar-hidden`)
- [x] Icons / List layout: Toolbar → Layout options (`browser-layout-options-menu`, `browser-list-view`)
- [x] Sort by Date / Name; tapping the active sort flips its direction: Toolbar → … → Sort by (`browser-sort-by-date-submenu`, `browser-more-menu-sortname`)
- [x] Use Groups (date headers): Toolbar → … → Use Groups (`browser-list-use-groups`)
- [x] Select mode with Select All, Duplicate, Delete: Toolbar → … → Select (`browser-select-mode`, `browser-select-one`)
- [x] Board menu (Move to, Duplicate, Rename, Delete, Favorite, Share): Long-press a card (`browser-board-longpress-menu`)
- [x] New folder: Sidebar → New Folder (`browser-new-folder-dialog`, `browser-folder-created`)
- [x] Nested folders, plus the folder menu (Move to, Duplicate, Rename, New Folder, Delete, Share): Long-press a folder (`browser-folder-longpress-menu`)
- [x] Favorite heart badge on cards: Favorites (`browser-favorites-with-board`)
- [x] Empty states (No Shared Boards / No Favorites / No Boards): Sidebar sections (`browser-shared-empty`, `browser-favorites-empty`, `browser-folder-empty`)
- [x] Search that finds titles, text and handwriting, with dictation: Search field (`browser-search-content-idea`, `browser-search-handwriting-hello`)
- [x] New board, with empty boards discarded: Compose button (`board-new-empty`, `browser-all-boards-after`)
- [x] Recents grouped by date: Sidebar → Recents (`browser-recents`)
- [ ] Shared boards / collaboration: none exist, and sharing is not allowed

## Board chrome
- [x] Insert capsule (Drawing, Text, Shape, Sticky, Table, Media): Top bar (`board-existing-untitled4-toolbar`)
- [x] Insert tools collapse into "+" when the title is long: Top bar (`board-toolbar-plus-collapsed-menu`)
- [x] Rename inline: Title → Rename (`board-rename-inline`)
- [x] Favorite / Unfavorite: Title menu (`board-title-menu-favorited`)
- [x] Export as PDF (Board / Scenes), Print: Title menu (`board-export-pdf-submenu`)
- [x] Find, with Whole Words / Match Case / Find & Replace: … → Find (`board-find-idea`, `board-find-options`)
- [x] Alignment Settings (Snap to Grid, Center, Edge, Spacing guides): … → Alignment Settings (`board-more-alignment-settings`)
- [x] Math Results (Insert / Suggest / Off): … → Math Results (`board-more-math-results`)
- [x] Freeform Help: … menu (`board-more-menu`)
- [x] Undo history: Long-press Undo (`undo-longpress`)
- [x] Share Board sheet (closed without sharing): Share button (`share-board-sheet`)
- [x] Content Hub: Toolbar icon (`content-hub`)

## Canvas
- [x] Zoom menu (10 to 400%, Zoom to Fit): Bottom-left % (`zoom-menu`, `zoom-25-percent`, `zoom-200-percent`, `zoom-to-fit-content`, `zoom-menu-and-pan.mp4`)
- [x] One-finger pan: Empty canvas, palette closed (`pan-one-finger`)
- [x] Dot grid on / off: Bottom-right grid toggle (`grid-toggled-off`)
- [x] Viewport remembered for each board: Reopen a board (`board-renamed`)
- [ ] Pinch zoom: multi-touch isn't supported on a physical device
- [ ] Other backgrounds: none exist in the board UI (Content Hub → Backgrounds has images only: `content-hub-backgrounds`)

## Elements
- [x] Sticky note: insert, edit, 7 fills, Aa, move: + → Sticky Note (`sticky-inserted`, `sticky-editing`, `sticky-fill-colors`, `sticky-text-format`, `sticky-moved`)
- [x] Copy Style / Save as Insert Style: Object … → Style (`sticky-more-style-submenu`)
- [x] Basic shapes (12): + → Shape (`shapes-library-basic`)
- [x] Shape fill, stroke, Change Shape library with 16 categories and search: Shape mini-toolbar (`shape-fill-popover`, `shape-stroke-popover`, `shape-change-shape-submenu`, `shape-library-categories-scrolled`)
- [x] Text box: colour, Aa, font picker, sizes 10 to 144 pt: + → Text (`text-inserted`, `text-format-popover`, `text-font-picker`, `text-size-popover`)
- [x] Table: rows and columns, Autogrow, borders, fill: + → Table (`table-inserted`, `table-options-popover`, `table-style-popover`)
- [x] Insert Media submenu (9 sources): + → Insert Media (`board-plus-insert-media-submenu`)
- [x] Image: Modify, Crop Mask, Preview, Shadow, Round Corners: Image mini-toolbar (`image-selected-menu`, `image-modify-popover`, `image-more-menu`)
- [x] Image Playground (system sheet): Insert Media → Image Playground (`ai-image-playground`)
- [ ] Choose File / Sticker / Link / Scan / Photo / Camera: these open personal files or the camera, so I stopped at the menu
- [x] Content Hub tabs (Discover, Photos, Graphics, Backgrounds, Shapes): Content Hub (`content-hub-photos`, `content-hub-graphics`, `content-hub-shapes`)

## Connectors
- [x] Connectors mode toggle: Bottom-right (`connectors-mode-on`)
- [x] Drag from a handle to create a connector: Selected object in connectors mode (`connectors-circle-selected`, `connector-created`, `connector-drag.mp4`)
- [x] Line ends, straight/elbow/curved, stroke: Connector mini-toolbar (`connector-line-ends-popover`, `connector-line-style-popover`, `connector-stroke-popover`)

## Selection and arrangement
- [x] Paste / Select Objects: Tap empty canvas (`canvas-tap-empty-menu`)
- [x] Multi-select mode (tap or drag), Select All: Select Objects (`multiselect-mode`, `multiselect-two-selected`)
- [x] Align (6 buttons): Multi-selection → Arrange (`multiselect-arrange-popover`)
- [x] Group / Ungroup: Arrange (`group-created`, `group-arrange-popover`, `board-after-ungroup`)
- [x] Lock / Unlock: Object mini-toolbar or … (`group-locked`)
- [x] Back / Front layer order: Object … (`sticky-more-menu`)
- [x] Cut, Copy, Paste, Duplicate, Delete, Description: Object … (`drawing-selected-more-menu`)
- [ ] Alignment guides seen live: nothing was nearby to align to in the recording (`move-sticky-guides.mp4`)

## Drawing tools
- [x] Open and close the palette: + → Drawing and Handwriting Tools (`tools-drawing-panel-open`, `tools-panel-closed`, `drawing-tools-open-close.mp4`)
- [x] Scribble, Pen, Monoline, Marker, Eraser, Lasso, Ruler, Pencil, Fill, Crayon, Fountain Pen, Reed, Watercolor: Palette (`tools-*-settings`)
- [x] Ruler on the canvas: Palette → Ruler (`tools-ruler-on-canvas`)
- [x] Colour picker (Grid, Spectrum, Sliders, hex, eyedropper, saved swatches): Palette → colour wheel (`tools-color-picker-grid`, `tools-color-picker-spectrum`, `tools-color-picker-sliders`)
- [x] Auto-Minimize, Draw with Finger, Auto-Refine Handwriting, Check Spelling: Palette → … (`tools-palette-more-menu`, `tools-palette-more-autorefine-on`)
- [x] Dock the palette at the bottom or the right: Drag the palette handle (`tools-palette-moved`, `palette-drag-handle.mp4`)
- [x] Drawing object: stroke colour, Duplicate, Delete, …: Select a drawing (`drawing-selected-menu`, `drawing-set-stroke-color`)
- [x] Finger drawing: Palette open (`draw-finger-hill-autorefine`, `finger-writing-autorefine.mp4`)
- [ ] Pencil hover, squeeze, barrel roll, double-tap, pressure: no Apple Pencil (finger input only)
- [ ] Draw-and-hold shape recognition: no way to hold at the end of a stroke
- [ ] Pencil Settings…: opens iPadOS Settings, which the brief says not to change

## Scenes
- [x] Show the scene navigator: Star button (`scenes-star-tap`, `scenes-navigator-empty`)
- [x] Scene list with empty state, Add Scene: Navigator ☰ (`scenes-list-empty`, `scenes-one-added`, `scenes-list-two`)
- [x] Rename, Replace, Print, Export PDF, Delete: Scene row … (`scenes-row-more-menu`)
- [x] Print Scenes / Export Scenes as PDF: List … (`scenes-list-more-menu`)
- [x] Reorder and delete: List Edit (`scenes-list-edit-mode`)
- [x] Prev / next animation: ‹ › (`scenes-jump-scene1`, `scenes-jump-scene2`, `scenes-prev-next.mp4`)

## Paywalled (Apple Creator Studio, $12.99/month after a 1-month trial)
- [x] Premium Content Hub items insert watermarked: Content Hub (`content-hub-premium-tap`, `content-hub-paywall`)
- [x] Generate Image: Content Hub / Insert Media (`ai-generate-image`)
- [x] Generate from Image, Super Resolution: Image → Modify Image (`image-modify-popover`)
