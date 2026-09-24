import XCTest
@testable import TikTokForWork

/// The thread under a card, as the Worker sends it: comments with the
/// names of whoever was mentioned, reactions folded per emoji, and the
/// set a person may add. A phone that read any of this wrong would show
/// a conversation that did not happen.
final class ThreadServiceTests: XCTestCase {
    func testAThreadDecodesWithNamesAndReactions() throws {
        let json = """
        {"comments":[{"id":"c1","author":"u:toru@x.jp","authorName":"Toru Bando","body":"@Mika the supplier confirmed.","mentions":["u:mika@x.jp"],"createdAt":"2026-09-24T01:00:00.000Z"}],
         "reactions":[{"emoji":"👍","count":2,"mine":true,"names":["Mika Sato","Toru Bando"]}],
         "available":["👍","✅"],"maxChars":2000}
        """.data(using: .utf8)!
        let thread = try JSONDecoder().decode(ThreadService.Thread.self, from: json)
        XCTAssertEqual(thread.comments.count, 1)
        XCTAssertEqual(thread.comments[0].displayAuthor, "Toru Bando")
        XCTAssertEqual(thread.comments[0].mentions, ["u:mika@x.jp"])
        XCTAssertEqual(thread.reactions.first?.count, 2)
        XCTAssertEqual(thread.reactions.first?.mine, true)
        XCTAssertEqual(thread.available, ["👍", "✅"])
    }

    func testAnEmptyThreadIsStillAThread() throws {
        let thread = try JSONDecoder().decode(ThreadService.Thread.self, from: "{}".data(using: .utf8)!)
        XCTAssertTrue(thread.comments.isEmpty)
        XCTAssertTrue(thread.reactions.isEmpty)
    }

    func testAnAuthorWithoutANameIsNeverAnAddress() throws {
        let json = """
        {"id":"c2","author":"u:kenji@example.com","body":"Done.","createdAt":"2026-09-24T01:00:00.000Z"}
        """.data(using: .utf8)!
        let comment = try JSONDecoder().decode(ThreadService.Comment.self, from: json)
        XCTAssertEqual(comment.mentions, [])
        XCTAssertFalse(comment.displayAuthor.contains("@"))
        XCTAssertFalse(comment.displayAuthor.hasPrefix("u:"))
    }

    func testACardCarriesItsThreadSummary() throws {
        let json = """
        {"id":"c1","recipientUserID":"alice","senderUserID":"bob","type":"approval","title":"Menu","summary":"","context":"",
         "status":"pending","priority":"medium","createdAt":"2026-09-24T01:00:00Z","commentCount":3,"lastCommentAt":"2026-09-24T02:00:00Z",
         "reactions":{"👍":2},"mentions":["r1"]}
        """.data(using: .utf8)!
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let card = try decoder.decode(DecisionCard.self, from: json)
        XCTAssertEqual(card.commentCount, 3)
        XCTAssertEqual(card.reactions?["👍"], 2)
        XCTAssertEqual(card.mentions, ["r1"])
    }
}
