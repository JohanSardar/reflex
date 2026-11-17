import UIKit

/// SF Symbols for the board's library, by category. iPadOS has no API to list every
/// symbol, so these are picked by hand; search matches their names.
enum SymbolCatalog {
    struct Category {
        let name: String
        let symbols: [String]
    }

    static let categories: [Category] = raw.map {
        Category(name: $0.name, symbols: $0.symbols.filter { UIImage(systemName: $0) != nil })
    }

    private static let raw: [Category] = [
        Category(
            name: "Objects",
            symbols: [
                "pencil", "highlighter", "paintbrush", "scissors", "ruler", "paperclip", "pin.fill", "book.fill",
                "books.vertical.fill", "bookmark.fill", "folder.fill", "doc.fill", "tray.full.fill", "archivebox.fill",
                "calendar", "clock.fill", "alarm.fill", "stopwatch.fill", "hourglass", "lightbulb.fill",
                "lamp.desk.fill", "key.fill", "lock.fill", "bell.fill", "tag.fill", "gift.fill", "bag.fill",
                "cart.fill", "creditcard.fill", "briefcase.fill", "hammer.fill", "wrench.and.screwdriver.fill",
                "screwdriver.fill", "gearshape.fill", "magnifyingglass", "flashlight.on.fill", "camera.fill",
                "photo.fill", "film.fill", "tv.fill", "desktopcomputer", "laptopcomputer", "ipad", "iphone",
                "applewatch", "keyboard.fill", "printer.fill", "headphones", "speaker.wave.2.fill", "mic.fill",
                "gamecontroller.fill", "puzzlepiece.fill", "cube.fill", "shippingbox.fill", "trash.fill",
                "umbrella.fill", "eyeglasses", "crown.fill", "trophy.fill", "medal.fill",
            ]),
        Category(
            name: "Symbols",
            symbols: [
                "star.fill", "heart.fill", "checkmark.circle.fill", "xmark.circle.fill",
                "exclamationmark.triangle.fill", "questionmark.circle.fill", "info.circle.fill", "plus.circle.fill",
                "minus.circle.fill", "bolt.fill", "flag.fill", "sparkles", "seal.fill", "checkmark.seal.fill", "number",
                "at", "percent", "dollarsign.circle.fill", "eurosign.circle.fill", "infinity", "sum", "function",
                "x.squareroot", "divide", "equal", "lessthan", "greaterthan", "circle.fill", "square.fill",
                "triangle.fill", "diamond.fill", "hexagon.fill", "octagon.fill", "seal", "rays", "target", "scope",
                "smallcircle.filled.circle", "asterisk", "command", "option", "power", "wifi",
                "antenna.radiowaves.left.and.right", "link", "qrcode", "barcode", "recordingtape", "music.note",
                "quote.opening", "quote.closing",
            ]),
        Category(
            name: "Arrows",
            symbols: [
                "arrow.right", "arrow.left", "arrow.up", "arrow.down", "arrow.up.right", "arrow.down.right",
                "arrow.left.and.right", "arrow.up.and.down", "arrow.clockwise", "arrow.counterclockwise",
                "arrow.triangle.2.circlepath", "arrow.turn.down.right", "arrow.uturn.left", "arrow.uturn.right",
                "arrow.right.circle.fill", "arrow.left.circle.fill", "arrow.up.circle.fill", "arrow.down.circle.fill",
                "chevron.right", "chevron.left", "chevron.up", "chevron.down", "chevron.right.2",
                "arrowshape.right.fill", "arrowshape.left.fill", "arrowshape.up.fill", "arrowshape.down.fill",
                "arrow.triangle.branch", "arrow.triangle.merge", "arrow.triangle.swap", "arrow.up.arrow.down",
                "arrow.right.arrow.left", "arrow.up.left.and.arrow.down.right", "arrow.down.left.and.arrow.up.right",
                "point.topleft.down.to.point.bottomright.curvepath", "return", "repeat", "shuffle",
            ]),
        Category(
            name: "People",
            symbols: [
                "person.fill", "person.2.fill", "person.3.fill", "person.crop.circle.fill", "person.badge.plus",
                "figure.walk", "figure.run", "figure.stand", "figure.wave", "figure.2.and.child.holdinghands",
                "figure.roll", "figure.yoga", "hand.raised.fill", "hand.thumbsup.fill", "hand.thumbsdown.fill",
                "hand.wave.fill", "hand.point.up.left.fill", "hands.clap.fill", "eye.fill", "ear.fill",
                "brain.head.profile", "brain", "mouth.fill", "nose.fill", "face.smiling", "face.dashed",
                "bubble.left.fill", "bubble.right.fill", "bubble.left.and.bubble.right.fill", "quote.bubble.fill",
                "text.bubble.fill", "ellipsis.bubble.fill", "envelope.fill", "phone.fill", "video.fill",
            ]),
        Category(
            name: "Nature",
            symbols: [
                "sun.max.fill", "moon.fill", "moon.stars.fill", "cloud.fill", "cloud.rain.fill", "cloud.bolt.fill",
                "cloud.snow.fill", "cloud.sun.fill", "snowflake", "wind", "tornado", "drop.fill", "flame.fill",
                "leaf.fill", "tree.fill", "camera.macro", "mountain.2.fill", "globe.americas.fill",
                "globe.europe.africa.fill", "sparkle", "rainbow", "thermometer.medium", "humidity.fill", "water.waves",
                "bird.fill", "fish.fill", "pawprint.fill", "tortoise.fill", "hare.fill", "ant.fill", "ladybug.fill",
                "cat.fill", "dog.fill", "lizard.fill", "carrot.fill", "apple.logo",
            ]),
        Category(
            name: "Places",
            symbols: [
                "house.fill", "building.fill", "building.2.fill", "building.columns.fill", "storefront.fill",
                "tent.fill", "map.fill", "mappin.and.ellipse", "location.fill", "signpost.right.fill", "flag.checkered",
                "car.fill", "bus.fill", "tram.fill", "bicycle", "scooter", "airplane", "sailboat.fill", "ferry.fill",
                "fuelpump.fill", "parkingsign", "road.lanes", "suitcase.fill", "bed.double.fill", "fork.knife",
                "cup.and.saucer.fill", "wineglass.fill", "birthday.cake.fill", "takeoutbag.and.cup.and.straw.fill",
                "cross.case.fill", "pills.fill", "stethoscope", "heart.text.square.fill", "graduationcap.fill",
                "studentdesk", "theatermasks.fill", "sportscourt.fill", "soccerball", "basketball.fill",
                "football.fill", "tennisball.fill",
            ]),
        Category(
            name: "Work",
            symbols: [
                "chart.bar.fill", "chart.pie.fill", "chart.line.uptrend.xyaxis", "chart.xyaxis.line", "list.bullet",
                "list.number", "checklist", "list.bullet.clipboard.fill", "doc.text.fill", "doc.richtext.fill",
                "note.text", "square.and.pencil", "text.alignleft", "tablecells.fill", "rectangle.grid.2x2.fill",
                "square.grid.3x3.fill", "rectangle.split.3x1.fill", "sidebar.left", "calendar.badge.clock",
                "clock.arrow.circlepath", "timer", "server.rack", "externaldrive.fill", "cpu.fill", "memorychip.fill",
                "network", "terminal.fill", "chevron.left.forwardslash.chevron.right", "curlybraces", "ladybug",
                "hammer", "cylinder.fill", "point.3.connected.trianglepath.dotted", "flowchart.fill",
                "person.2.wave.2.fill", "megaphone.fill", "lightbulb.max.fill", "target", "dollarsign", "banknote.fill",
                "signature", "paperplane.fill", "tray.and.arrow.down.fill", "square.and.arrow.up.fill", "icloud.fill",
                "lock.shield.fill", "key.horizontal.fill",
            ]),
        Category(
            name: "Education",
            symbols: [
                "graduationcap", "book.closed.fill", "text.book.closed.fill", "character.book.closed.fill",
                "magazine.fill", "newspaper.fill", "studentdesk", "pencil.and.ruler.fill", "compass.drawing",
                "function", "sum", "x.squareroot", "plus.forwardslash.minus", "angle", "atom", "flask.fill",
                "testtube.2", "microscope.fill", "globe", "abc", "textformat", "character", "a.circle.fill",
                "1.circle.fill", "2.circle.fill", "3.circle.fill", "4.circle.fill", "5.circle.fill",
                "questionmark.bubble.fill", "lightbulb.2.fill", "brain.fill", "puzzlepiece.extension.fill",
                "medal.star.fill", "rosette",
            ]),
    ]

    static let all: [String] = Array(Set(categories.flatMap(\.symbols))).sorted()
}
