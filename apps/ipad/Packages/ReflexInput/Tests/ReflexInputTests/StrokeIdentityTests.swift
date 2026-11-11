import PencilKit
import UIKit
import XCTest

@testable import ReflexInput

final class StrokeIdentityTests: XCTestCase {
    private let ink = PKInk(.pen, color: .black)
    private let created = Date(timeIntervalSinceReferenceDate: 800_000_000)

    private func path() -> PKStrokePath {
        let points = (0...100).map {
            PKStrokePoint(
                location: CGPoint(x: Double($0) * 10, y: 0), timeOffset: Double($0) * 0.01,
                size: CGSize(width: 3, height: 3), opacity: 1, force: 1,
                azimuth: 0, altitude: .pi / 2
            )
        }
        return PKStrokePath(controlPoints: points, creationDate: created)
    }

    /// One fragment of the same stroke: same path, same seed, a mask that leaves
    /// only the ink between `from` and `to`.
    private func fragment(from: CGFloat, to: CGFloat) -> PKStroke {
        let mask = UIBezierPath(rect: CGRect(x: from, y: -50, width: to - from, height: 100))
        return PKStroke(ink: ink, path: path(), transform: .identity, mask: mask, randomSeed: 42)
    }

    /// A precise erase across two fragments of one stroke must keep each new
    /// fragment's own parent, as StrokeRecord's contract says.
    func testPreciseEraseAcrossTwoFragmentsKeepsEachParent() {
        var ledger = StrokeLedger()
        let first = ledger.reconcile([fragment(from: 0, to: 500), fragment(from: 500, to: 1000)])
        XCTAssertEqual(first.added.count, 2, "two fragments are added")

        let second = ledger.reconcile([fragment(from: 0, to: 200), fragment(from: 800, to: 1000)])
        XCTAssertEqual(second.added.count, 2, "the erase leaves two fragments")
        let parents = second.added.map(\.parent)
        XCTAssertEqual(parents[0], first.added[0].id, "the left fragment's parent is the left fragment")
        XCTAssertEqual(parents[1], first.added[1].id, "the right fragment's parent is the right fragment")
    }
}
