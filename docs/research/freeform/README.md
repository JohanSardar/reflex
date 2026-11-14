# Apple Freeform on iPad: a full map

App: Freeform (`com.apple.freeform`), iPadOS 26, on the person's real iPad (1668×2388 px screen). It was mapped on 14 Nov 2026 with agent-device (session `freeform`), using finger input only.

Screenshots are in `shots/` (downscaled `.jpg` copies in this repo). Recordings live outside git at `~/reflex-research/freeform/video/`, and each one has a `-contact-sheet.png` next to it. Every claim below names the screenshot (📷) or video (🎬) it comes from.

## Overview

Freeform has two screens: a **board browser**, which is a sidebar plus a grid or list of board cards, and a **board**, which is an infinite white canvas with a faint dot grid. The board's chrome is very small:

- **Top bar:** back, the board title, one glass capsule of insert tools, and a capsule for undo, share and more.
- **Bottom-left:** a small capsule with the zoom % and Scenes.
- **Bottom-right:** a small capsule with the Connectors and Grid toggles.

Every object you place gets the same floating glass **mini-toolbar** above it when it's selected: 2–4 type-specific buttons, then Duplicate, Delete and "…". The "…" menu always starts with Back/Front layer buttons. Drawing uses the system **PencilKit palette**, a vertical floating strip docked on the right edge that you open and close from the insert capsule.

Advanced features are tucked away instead of shown:
- **Scenes:** saved viewports you can step through.
- **Connectors:** a mode toggle.
- **Alignment guides:** a settings submenu.
- **Math results, Find & Replace, export:** menus.

Paywalls only appear around Apple Creator Studio content (premium images and AI image generation). The core canvas is free.

**Does it neaten handwriting automatically?** Yes, but only if you opt in. The drawing palette's "…" menu has **Auto-Refine Handwriting**, which is Apple's Smart Script. It is **off by default** 📷 `tools-palette-more-menu`, 📷 `tools-palette-more-autorefine-on`. My finger-drawn test strokes were synthetic straight lines, so I couldn't see any refinement 📷 `draw-finger-hill-autorefine` 🎬 `finger-writing-autorefine.mp4`. I set it back to off afterwards 📷 `tools-palette-more-restored`. Freeform does make handwriting **searchable**: board-browser search found a board from the word "hello" written in it 📷 `browser-search-handwriting-hello`.

---

## 1. Board browser

| Feature | Path | What it does | Evidence |
|---|---|---|---|
| Sidebar sections | Browser → sidebar | **All Boards**, **Recents**, **Shared** and **Favorites**, each with a count, plus **Folders** | 📷 `browser-home` |
| Hide sidebar | Sidebar toggle (top-left) | The grid widens from 3 to 4 columns | 📷 `browser-sidebar-hidden` |
| Grid / List | Toolbar → Layout options → Icons / List | Large thumbnail cards, or rows with a small thumbnail, date and folder | 📷 `browser-layout-options-menu`, 📷 `browser-list-view` |
| "…" menu | Toolbar → "…" | Select, Sort by (Date / Name), Use Groups | 📷 `browser-more-menu`, 📷 `browser-sort-by-date-submenu` |
| Sort | "…" → Sort by → Date / Name | Tapping the active sort again flips its direction | 📷 `browser-more-menu-sortname`, 📷 `browser-more-menu-2`, 📷 `browser-more-menu-3` |
| Use Groups | "…" → Use Groups (date sort only) | Adds date headers such as "Previous 30 Days"; has no effect when sorting by name | 📷 `browser-list-use-groups`, 📷 `browser-list-sort-name-groups` |
| Recents | Sidebar → Recents | Always grouped by date | 📷 `browser-recents` |
| Shared (empty) | Sidebar → Shared | "No Shared Boards" empty state | 📷 `browser-shared-empty` |
| Favorites | Sidebar → Favorites | Empty state "No Favorites"; favorited cards get a heart badge | 📷 `browser-favorites-empty`, 📷 `browser-favorites-with-board` |
| Select mode | "…" → Select | Select All / Done; a bottom bar with Duplicate and Delete | 📷 `browser-select-mode`, 📷 `browser-select-one`, 📷 `browser-select-one-more` |
| Board context menu | Long-press a board card | Move to, Duplicate, Rename, Delete, Favorite, Share | 📷 `browser-board-longpress-menu` |
| New folder | Sidebar → New Folder | A name dialog; the new folder shows a "Share Folder" tip | 📷 `browser-new-folder-dialog`, 📷 `browser-new-folder-named`, 📷 `browser-folder-created` |
| Folder context menu | Long-press a folder | Move to, Duplicate, Rename, **New Folder** (nested folders), Delete, Share | 📷 `browser-folder-longpress-menu` |
| Folder contents | Sidebar → folder | Empty state "No Boards"; board cards show the folder name | 📷 `browser-folder-empty`, 📷 `browser-folder-with-board` |
| Search | Search field (top-right; collapses to an icon in List view) | Searches titles, typed text **and handwriting**; has a dictation mic | 📷 `browser-search-focused`, 📷 `browser-search-content-idea`, 📷 `browser-search-handwriting-hello` |
| New board | Compose button | Opens an empty "Untitled N" board. Empty boards are thrown away when you leave them. | 📷 `board-new-empty`, 📷 `browser-all-boards-after` |
| Rating prompt | Appeared on its own | The App Store "Enjoying Freeform?" prompt; I tapped Not Now | 📷 `browser-rating-prompt` |

## 2. Board chrome and visual design

- **Full toolbar** (short title) 📷 `board-existing-untitled4-toolbar`:
  - Left: Back, then the title with a chevron.
  - Centre: a glass capsule of 6 insert tools (Drawing tools, Text, Shape, Sticky, Table, Media), then Content Hub.
  - Right: a capsule with Undo, Share and "…", then New Board.
  - The icons are monochrome SF Symbols on Liquid Glass capsules, with no labels.
- **Collapsed toolbar** (longer title "Reflex research"): the 6 insert tools fold into a single **"+"** menu 📷 `board-toolbar-plus-collapsed-menu`. The toolbar gives up controls before it gives up the title.
- **Title menu:** Rename (edited inline in the nav bar), Favorite, Export as PDF (with a Board / Scenes submenu once scenes exist), Print 📷 `board-title-actions-menu`, 📷 `board-rename-inline`, 📷 `board-renamed`, 📷 `board-title-menu-favorited`, 📷 `board-export-pdf-submenu`.
- **Top "…" menu:** Find, Alignment Settings, Math Results, Freeform Help 📷 `board-more-menu`.
  - **Alignment Settings:** Snap to Grid (off), Center Guides (on), Edge Guides (off), Spacing Guides (on) 📷 `board-more-alignment-settings`.
  - **Math Results:** Insert / Suggest (default) / Off 📷 `board-more-math-results`.
  - **Find:** dims the board and highlights matches with up/down arrows. Options are Whole Words, Match Case and Find & Replace 📷 `board-find-idea`, 📷 `board-find-options`. Find did **not** match my synthetic handwriting, which was still showing "handwriting recognition in progress" 📷 `board-find-handwriting-hill`.
- **Undo:** long-press shows the undo/redo history 📷 `undo-longpress`. Undo history is cleared when you leave the board.
- **Share Board:** a system sheet with "Share a Link" and "People you choose can edit.", contacts, AirDrop, Messages, Mail, Copy Link and Add Access. I closed it without sharing. Contacts are blurred in the screenshot 📷 `share-board-sheet`.
- **Overall look:** a white canvas, a light grey dot grid, glass capsules floating at the four edges, and nothing else on screen 📷 `board-elements-overview`.

## 3. The infinite board: zoom, scrolling, grid

| Feature | Path | Notes | Evidence |
|---|---|---|---|
| Zoom menu | Bottom-left "100%" | 10, 25, 50, 75, 100, 200, 400%, Zoom to Fit Content | 📷 `zoom-menu`, 📷 `zoom-menu-at-200` |
| Zoom levels | Zoom menu | The zoom is animated, and the dot grid scales with it | 📷 `zoom-25-percent`, 📷 `zoom-200-percent` 🎬 `zoom-menu-and-pan.mp4` |
| Zoom to fit | Zoom menu → Zoom to Fit Content | Frames all content (110% here) | 📷 `zoom-to-fit-content` |
| Pan | One finger on empty canvas (drawing palette closed) | Free scrolling in every direction | 📷 `pan-one-finger` 🎬 `zoom-menu-and-pan.mp4` |
| Pinch zoom | Two fingers | **Not testable.** agent-device doesn't support multi-touch on physical devices. | (none) |
| Grid | Bottom-right grid button | Shows or hides the dot grid. **No other background options exist in the board** (no lined or colour backgrounds). Content Hub has a "Backgrounds" image category instead. | 📷 `grid-toggled-off`, 📷 `content-hub-backgrounds` |
| Viewport memory | Reopen a board | The board reopens at its last scroll position and zoom | 📷 `board-renamed` |

## 4. Creating elements

Insert tools are on the capsule, or under "+" when the toolbar is collapsed. New objects appear at the centre of the view, already selected.

### Sticky notes
- **Insert:** a square yellow note with the placeholder "Double-tap to enter text" 📷 `sticky-inserted`.
- **Edit text:** double-tap. The keyboard bar gains Aa / B I U / align / list 📷 `sticky-editing`, 📷 `sticky-typed`.
- **Mini-toolbar:** Fill, Aa, Duplicate, Delete, … 📷 `sticky-selected-menu`.
  - **Fill:** 7 colours 📷 `sticky-fill-colors`.
  - **Aa:** B/I/U, alignment, vertical alignment, size in pt (±), lists 📷 `sticky-text-format`.
  - **"…":** Back/Front, Cut, Copy, Paste, Duplicate, Lock, Style ▸ (Copy Style / Save as Insert Style), Constrain Proportions, Description, Delete 📷 `sticky-more-menu`, 📷 `sticky-more-style-submenu`.
- **Move:** drag 📷 `sticky-moved` 🎬 `move-sticky-guides.mp4`. I didn't catch any alignment guide in the recording, because nothing was nearby to align to. Long-press works the same as a tap 📷 `sticky-longpress`.

### Shapes
- **Shape popover:** 12 basic shapes (rounded rect, line, arrow, connection line, circle, triangle, pentagon, square, diamond, terminator, parallelogram, block arrow) plus "Browse Content Hub" 📷 `shapes-library-basic`.
- **Insert:** 📷 `shape-circle-inserted`.
- **Mini-toolbar:** Fill, Stroke, Aa, Duplicate, Delete, … 📷 `shape-selected-menu`.
  - **Fill:** 12 colours, No Fill and a colour wheel 📷 `shape-fill-popover`.
  - **Stroke:** none / solid / dash / dot / brush 📷 `shape-stroke-popover`.
  - **"…":** adds Change Shape and Autosize Text 📷 `shape-more-menu`.
- **Change Shape:** opens the full library, which has search and 16 categories (Basic, Geometry, Objects, Animals, Nature, Food, Symbols, Education, Arts, Science, People, Places, Activities, Transportation, Work, Ornaments) 📷 `shape-change-shape-submenu`, 📷 `shape-library-categories-scrolled`.

### Text boxes
- **Insert:** side handles plus a green handle 📷 `text-inserted`. Move and edit 📷 `text-moved`, 📷 `text-editing`.
- **Mini-toolbar:** Colour, Aa, Size, Duplicate, Delete, … 📷 `text-selected-menu`.
  - **Aa:** B/I/U, font, alignment, vertical alignment, lists 📷 `text-format-popover`.
  - **Size:** a list from 10 to 144 pt 📷 `text-size-popover`.
  - **Font:** the system font picker, with search 📷 `text-font-picker`.
  - **"…":** adds Add to Playground 📷 `text-more-menu`.

### Tables
- **Insert:** a 2×2 table with + buttons for rows and columns, and an "Attach Objects" tip 📷 `table-inserted`.
- **Layout:** rows and columns steppers, Autogrow Cells 📷 `table-options-popover`.
- **Style:** 6 border presets, line style, pt, colour, Table Fill 📷 `table-style-popover`.

### Images, media and files
- **Insert Media submenu:** Browse Content Hub, Generate Image, Choose Photo or Video, Take Photo or Video, Image Playground, Choose Sticker, Choose File, Add Link, Scan Documents 📷 `board-plus-insert-media-submenu`.
- **Image mini-toolbar:** 📷 `image-selected-menu`.
  - **Modify Image:** filename and size, Generate from Image, Super Resolution 📷 `image-modify-popover`.
  - Crop Mask, Preview, Duplicate, Delete.
  - **"…":** adds Shadow, Round Corners, Style, Constrain Proportions 📷 `image-more-menu`.
- **Not opened:** the File, Sticker, Link, Scan and Photo pickers. They open the person's photos or files or the camera, so I stopped at the menu.

### Content Hub (toolbar icon)
- **Layout:** Discover / Photos / Graphics / Backgrounds / Shapes tabs, search, Generate Image, and featured collections 📷 `content-hub`, 📷 `content-hub-photos`, 📷 `content-hub-graphics`, 📷 `content-hub-backgrounds`, 📷 `content-hub-shapes`.
- **Premium items:** most carry a premium badge. Inserting one places it **watermarked**, with a "Remove Watermarks" chip and a terms banner 📷 `content-hub-premium-tap`. See Paywalls.

## 5. Connectors
- **Connectors mode:** turn it on with the bottom-right toggle 📷 `connectors-mode-on`. Selecting an object then shows 4 arrow handles 📷 `connectors-circle-selected`.
- **Create a connector:** drag a handle onto another object 📷 `connector-created` 🎬 `connector-drag.mp4`.
- **Mini-toolbar:** line ends (start/end), style (straight / elbow / curved), stroke (style, pt ±, colour) 📷 `connector-selected-menu`, 📷 `connector-line-ends-popover`, 📷 `connector-line-style-popover`, 📷 `connector-stroke-popover`. A green midpoint handle bends the line.
- **Quirk:** after the two ends were grouped, the connector was drawn centre-to-centre across the shapes 📷 `group-created`.

## 6. Selection, multi-select, arrange, group, lock, layers
- **Tap on empty canvas:** a "Paste | Select Objects" menu 📷 `canvas-tap-empty-menu`. Long-press on empty canvas does nothing 📷 `canvas-longpress-empty`.
- **Select Objects mode:** a banner reads "To select or deselect an object, tap it. To select multiple objects, drag across them.", with Select All and Done 📷 `multiselect-mode`, 📷 `multiselect-two-selected`, 📷 `multiselect-done`.
- **Arrange (multi-selection):** 6 align buttons plus Group 📷 `multiselect-arrange-popover`.
- **Group:** 📷 `group-created`, 📷 `group-selected-menu`.
  - Arrange → Ungroup 📷 `group-arrange-popover`, 📷 `board-after-ungroup`.
  - "…" menu 📷 `group-more-menu`.
- **Lock:** a locked object shows grey ×-handles, and its menu offers only Unlock and "…" 📷 `group-locked`.
- **Layers:** every "…" menu starts with **Back / Front** buttons 📷 `sticky-more-menu`, 📷 `shape-more-menu`. There's no layers panel.
- **Alignment guides:** set in Alignment Settings (§2). I couldn't capture them in action 🎬 `move-sticky-guides.mp4`.

## 7. Drawing tools panel
- **Open and close:** "+" (or the pen icon in the capsule) → Drawing and Handwriting Tools. The palette slides in on the right and **stays open until you toggle it off**. While it's open, one finger draws instead of panning 📷 `tools-drawing-panel-open`, 📷 `tools-panel-closed`, 📷 `tools-plus-menu-while-drawing` 🎬 `drawing-tools-open-close.mp4`.
- **Palette layout:** a vertical glass strip with undo/redo at the top, a scrollable tool list, 6 colour swatches (yellow, black, red, blue, green, picker) and "…" 📷 `tools-palette-scrolled`, 📷 `tools-palette-scrolled-end`.
- **Tools:** tap the selected tool again to open its settings.
  - **Scribble:** 📷 `tools-scribble-settings`.
  - **Pen, Monoline, Marker, Pencil, Crayon, Fountain Pen, Watercolor:** 5 weights plus opacity 📷 `tools-pen-settings`, 📷 `tools-monoline-settings`, 📷 `tools-marker-settings`, 📷 `tools-pencil-settings`, 📷 `tools-crayon-settings`, 📷 `tools-fountain-pen-settings`, 📷 `tools-watercolor-settings`.
  - **Reed:** 5 nib angles plus width and opacity 📷 `tools-reed-settings`.
  - **Fill:** opacity only 📷 `tools-fill-settings`.
  - **Eraser:** Pixel / Object plus 5 sizes 📷 `tools-eraser-settings`.
  - **Lasso:** All Objects / Drawings Only 📷 `tools-lasso-settings`.
  - **Ruler:** 📷 `tools-ruler-settings`, 📷 `tools-ruler-on-canvas`.
- **Colour picker:** Grid / Spectrum / Sliders tabs, eyedropper, opacity %, sRGB hex, and saved swatches with + 📷 `tools-color-picker-grid`, 📷 `tools-color-picker-spectrum`, 📷 `tools-color-picker-sliders`. Each tool remembers its own colour.
- **Palette "…" settings:** Auto-Minimize (off), Draw with Finger (on), Auto-Refine Handwriting (off), Check Handwritten Spelling (on), and Pencil Settings… (which opens iPadOS Settings, so I didn't tap it) 📷 `tools-palette-more-menu`.
- **Move the palette:** drag its handle and it snaps to the bottom edge as a horizontal bar 📷 `tools-palette-moved`, 📷 `tools-palette-back-right` 🎬 `palette-drag-handle.mp4`.
- **Drawn strokes:** they become a single object with the mini-toolbar: stroke colour (12 swatches + More), Duplicate, Delete, and "…" (Cut, Copy, Paste, Duplicate, Lock, Description, Add to Playground, Delete) 📷 `drawing-selected-menu`, 📷 `drawing-set-stroke-color`, 📷 `drawing-selected-more-menu`.
- **Pencil-only (not testable with a finger):** hover previews, squeeze for the palette, barrel roll, double-tap to switch tools, pressure and tilt. I also couldn't test draw-and-hold shape recognition, because agent-device can't hold at the end of a stroke.

## 8. Scenes
- **Scene navigator:** the star button (bottom-left) toggles the "‹ ☰ ›" navigator 📷 `scenes-star-tap`, 📷 `scenes-navigator-empty`.
- **Scene list:** ☰ opens it. The empty state reads "Add scenes to easily present or jump to different regions of the board." 📷 `scenes-list-empty`.
- **Add Scene:** captures the current viewport 📷 `scenes-one-added`, 📷 `scenes-list-one`, 📷 `scenes-list-two`.
- **Row "…":** Rename, Replace, Print Scene, Export Scene as PDF, Delete 📷 `scenes-row-more-menu`.
- **List "…":** Print Scenes, Export Scenes as PDF 📷 `scenes-list-more-menu`. Edit mode adds delete and reorder handles 📷 `scenes-list-edit-mode`.
- **‹ / ›:** move between scenes with an animation 📷 `scenes-jump-scene1`, 📷 `scenes-jump-scene2` 🎬 `scenes-prev-next.mp4`.

## 9. Paywalls (Apple Creator Studio)
- **Premium Content Hub items:** they insert watermarked, with the banner "Premium content is subject to the Apple Creator Studio Terms and Conditions. OK" 📷 `content-hub-premium-tap`.
  - Tapping "Remove Watermarks" opens the paywall 📷 `content-hub-paywall`: "**Apple Creator Studio** — Unlock your creativity with premium content and powerful intelligence. Free for 1 month. Supercharge Keynote, Pages, Numbers, and Freeform, plus get video, music, and creative imaging apps. Includes Final Cut Pro, Logic Pro, and Pixelmator Pro; Design with powerful intelligence (Beta); Premium images and graphics; Beautiful new templates and themes. 1 month free, then $12.99/month. Terms apply. [Accept Free Trial] [See All Plans]".
  - I closed it, and deleted the watermarked image.
- **Generate Image** (Content Hub, Insert Media): "**Generate Images** — Get Apple Creator Studio to generate images, icons, and backgrounds from text descriptions. Limits and age restrictions apply. [Continue] [Learn About Limits] [Cancel]". I tapped Cancel 📷 `ai-generate-image`.
- **Also premium-tagged:** Image → Generate from Image and Super Resolution 📷 `image-modify-popover`.
- **Free:** Image Playground, which is the system sheet ("Describe an image", Any Style). I closed it 📷 `ai-image-playground`.

## 10. Not reached, and why
- **Pinch zoom and two-finger gestures:** multi-touch isn't supported on physical devices by agent-device. I documented zoom through the zoom menu instead.
- **Apple Pencil features:** finger input only (§7).
- **Shape recognition by draw-and-hold:** I couldn't produce a hold at the end of a stroke.
- **Freeform's page in iPadOS Settings, and Pencil Settings…:** these are system settings, which the brief says not to change.
- **File / Sticker / Link / Scan / Photo / Camera pickers:** these open the person's personal files and photos, or the camera.
- **Shared boards and collaboration:** no shared boards exist, and sharing was off-limits.
- **Alignment guides in action:** the recording showed none appearing, because nothing was nearby to align to.

## State left on the iPad
- **Test folder:** a folder "Reflex research" holding the favorited board "Reflex research". It contains a blue "HILL" drawing, a "Canvas idea" sticky, a circle and connector, "Reflex canvas" text, a 2×2 table, and Scenes 1–2 📷 `browser-final-state`.
- **App settings:** all put back (date sort descending, Use Groups off, Icons view, Auto-Refine off, grid on, connectors off, palette on the right).
- **The person's own boards:** untouched.

---

## What Reflex should borrow
1. **One mini-toolbar pattern for every object:** 2–4 type-specific buttons, then Duplicate, Delete and "…", with layer Back/Front at the top of "…". You learn it once and it works on everything 📷 `sticky-selected-menu`, 📷 `shape-selected-menu`, 📷 `text-selected-menu`.
2. **Chrome that collapses:** six insert tools fold into "+" when space is tight, and the four corners hold small glass capsules 📷 `board-toolbar-plus-collapsed-menu`, 📷 `board-elements-overview`.
3. **A floating drawing palette** that stays open until you toggle it off, can dock on the right or the bottom, and keeps a colour per tool 📷 `tools-drawing-panel-open`, 📷 `tools-palette-moved`.
4. **Scenes as saved viewports**, with ‹ › stepping and PDF export. It's a cheap feature with a big payoff for presenting 🎬 `scenes-prev-next.mp4`.
5. **Searchable handwriting** in the board browser 📷 `browser-search-handwriting-hello`.
6. **Opt-in handwriting neatening** (Auto-Refine), kept in the palette's "…" menu 📷 `tools-palette-more-menu`.
7. **Alignment guides split into four switches** (center, edge, spacing, snap-to-grid) 📷 `board-more-alignment-settings`.
8. **A board browser** with All / Recents / Shared / Favorites, nested folders, grid or list, and sort by date or name with optional date groups 📷 `browser-home`, 📷 `browser-list-use-groups`.
9. **Throwing away empty boards** when you leave them, so the browser never fills up with blank boards 📷 `browser-all-boards-after`.
10. **Viewport memory** per board, and a zoom menu with Zoom to Fit Content 📷 `zoom-menu`.

## What to avoid
1. **Hidden connector mode.** Connectors need a separate bottom-right toggle; you can't drag them from any selected object. That's easy to miss 📷 `connectors-mode-on`.
2. **Select Objects behind a tap on empty canvas.** Multi-select with a finger takes two steps and a modal banner 📷 `canvas-tap-empty-menu`, 📷 `multiselect-mode`.
3. **Premium content mixed into the free library.** Inserting a watermarked item is the first sign of the paywall 📷 `content-hub-premium-tap`.
4. **Find that misses handwriting** while it's still being recognised, even though browser search can find it 📷 `board-find-handwriting-hill`.
5. **Undo history that's lost** when you leave a board.
6. **Only one background option** (a dot grid, on or off). There's no lined, squared or colour background 📷 `grid-toggled-off`.
7. **Overlong "…" menus** on objects (10+ rows mixing layer, clipboard, style and accessibility items) 📷 `sticky-more-menu`.
8. **Odd connector routing after grouping** (drawn centre-to-centre) 📷 `group-created`.
