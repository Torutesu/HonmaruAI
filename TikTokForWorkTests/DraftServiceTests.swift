import XCTest
@testable import TikTokForWork

/// The reply draft the Worker sends, decoded the way the sheet reads it; the
/// words shown when the Worker refuses; the request sent the way it reads it.
final class DraftServiceTests: XCTestCase {
    func testADraftAndItsLanguage() throws {
        let json = #"{"draft":"美香さん\n\n今回は見送ります。\n\nToru","language":"ja"}"#
        let d = try JSONDecoder().decode(DraftService.Draft.self, from: Data(json.utf8))
        XCTAssertTrue(d.draft.hasPrefix("美香さん"))
        XCTAssertEqual(d.language, "ja")
    }

    func testAnOlderWorkerSendsNoLanguage() throws {
        let d = try JSONDecoder().decode(DraftService.Draft.self, from: Data(#"{"draft":"Approved."}"#.utf8))
        XCTAssertNil(d.language)
    }

    func testTheWorkersOwnWordsAreShown() {
        let refused = Data(#"{"message":"Decide first; the reply follows the decision."}"#.utf8)
        XCTAssertEqual(DraftService.message(in: refused, status: 409), "Decide first; the reply follows the decision.")
        XCTAssertEqual(DraftService.message(in: Data("<html>".utf8), status: 502),
                       String(localized: "Your AI could not draft that just now."))
    }

    func testAReplyGoesOutTheWayTheWorkerReadsIt() throws {
        let data = try JSONEncoder().encode(DraftService.Outgoing(orgId: "personal:toru", text: "Not this time.\n\nToru"))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
        XCTAssertEqual(json, ["orgId": "personal:toru", "text": "Not this time.\n\nToru"])
        let sent = try JSONDecoder().decode(DraftService.Sent.self, from: Data(#"{"sent":true,"via":"Gmail"}"#.utf8))
        XCTAssertEqual(sent, DraftService.Sent(sent: true, via: "Gmail"))
        // Only the apps the Worker can reply through get the button.
        XCTAssertTrue(DraftService.sendable.contains("Gmail"))
        XCTAssertFalse(DraftService.sendable.contains("Notion"))
        XCTAssertEqual(DraftService.message(in: Data("<html>".utf8), status: 502, fallback: "Could not send."), "Could not send.")
    }

    func testTheRequestIsSentTheWayTheWorkerReadsIt() throws {
        let data = try JSONEncoder().encode(DraftService.Request(orgId: "personal:toru", cardId: "c-1", readerLanguage: "en"))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
        XCTAssertEqual(json, ["orgId": "personal:toru", "cardId": "c-1", "readerLanguage": "en"])
    }
}
