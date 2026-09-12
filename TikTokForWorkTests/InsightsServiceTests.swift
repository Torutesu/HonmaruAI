import XCTest
@testable import TikTokForWork

/// The metrics the Worker sends, decoded the way the screen reads them. The
/// Worker names each count after what it counts ("source", "action"); the
/// screen wants one shape, and this is where the two are reconciled.
final class InsightsServiceTests: XCTestCase {
    func testMetricsDecodeIntoOneShape() throws {
        let json = """
        {"days":7,"cards":5,"pending":2,"decided":3,"selfAddressed":1,
         "medianMinutesToDecide":120,"declineRate":0.3333,"nudges":1,
         "created":[{"day":"2026-09-10","count":0},{"day":"2026-09-11","count":5}],
         "bySource":[{"source":"You","count":4},{"source":"Gmail","count":1}],
         "byAction":[{"action":"approve","count":2},{"action":"decline","count":1}],
         "feedback":{"right":0,"wrong":1,"reasons":{"wrong-person":1}}}
        """
        let m = try JSONDecoder().decode(InsightsService.Metrics.self, from: Data(json.utf8))
        XCTAssertEqual(m.cards, 5)
        XCTAssertEqual(m.medianMinutesToDecide, 120)
        XCTAssertEqual(m.created.map(\.count), [0, 5])
        XCTAssertEqual(m.bySource.map(\.label), ["You", "Gmail"])
        XCTAssertEqual(m.byAction.first?.count, 2)
        XCTAssertEqual(m.feedback.reasons["wrong-person"], 1)
    }

    func testAnOlderWorkerIsStillReadable() throws {
        // Fields the Worker learned later are optional here, so a phone ahead
        // of its backend shows what it can rather than nothing.
        let json = """
        {"days":14,"cards":0,"pending":0,"decided":0,"feedback":{"right":0,"wrong":0,"reasons":{}}}
        """
        let m = try JSONDecoder().decode(InsightsService.Metrics.self, from: Data(json.utf8))
        XCTAssertNil(m.medianMinutesToDecide)
        XCTAssertEqual(m.nudges, 0)
        XCTAssertTrue(m.created.isEmpty)
    }

    func testFlagReasonsAreTheWorkersWords() {
        XCTAssertEqual(InsightsService.FlagReason.allCases.map(\.rawValue),
                       ["wrong-person", "not-a-decision", "wrong-priority", "wrong-words"])
    }
}
