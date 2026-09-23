import XCTest
@testable import TikTokForWork

/// The answer the Worker sends, decoded the way the sheet reads it; the words
/// the sheet shows when the Worker refuses; and the question sent the way the
/// Worker reads it.
final class AskServiceTests: XCTestCase {
    func testAnAnswerAndWhatItDrewOn() throws {
        let json = """
        {"answer":"You declined +5% in August until the lease was settled.",
         "related":[{"title":"Supplier price +5%","status":"decline","decidedAt":"2026-08-02T00:00:00Z","recipient":"kenji"},
                    {"title":"Lease renewal","status":"pending","decidedAt":null,"recipient":"toru"}]}
        """
        let a = try JSONDecoder().decode(AskService.Answer.self, from: Data(json.utf8))
        XCTAssertTrue(a.answer.hasPrefix("You declined"))
        XCTAssertEqual(a.related.map(\.when), ["2026-08-02", String(localized: "Waiting")])
        // Two decisions with different days are two rows, even with one title.
        XCTAssertEqual(Set(a.related.map(\.id)).count, 2)
    }

    func testAnAnswerWithNothingRelatedIsStillAnAnswer() throws {
        let a = try JSONDecoder().decode(AskService.Answer.self, from: Data(#"{"answer":"Nothing on record."}"#.utf8))
        XCTAssertEqual(a.answer, "Nothing on record.")
        XCTAssertTrue(a.related.isEmpty)
    }

    func testTheWorkersOwnWordsAreShown() {
        let refused = Data(#"{"message":"Your AI has no model to answer with on this deployment."}"#.utf8)
        XCTAssertEqual(AskService.message(in: refused, status: 503),
                       "Your AI has no model to answer with on this deployment.")
        // A gateway page is not the Worker talking.
        XCTAssertEqual(AskService.message(in: Data("<html>502</html>".utf8), status: 502),
                       String(localized: "Your AI could not answer that just now."))
        XCTAssertEqual(AskService.Failure.refused("x").errorDescription, "x")
    }

    func testTheQuestionIsSentTheWayTheWorkerReadsIt() throws {
        let data = try JSONEncoder().encode(
            AskService.Question(orgId: "personal:toru", cardId: "c-1", question: "Why?", readerLanguage: "ja")
        )
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
        XCTAssertEqual(json, ["orgId": "personal:toru", "cardId": "c-1", "question": "Why?", "readerLanguage": "ja"])
    }
}
