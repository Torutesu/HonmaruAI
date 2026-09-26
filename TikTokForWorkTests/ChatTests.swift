import XCTest
@testable import TikTokForWork

/// The chat tab's pure parts: what /schedule understands, how Slack's marks
/// and @names are read, and the Worker's message decoded as the list reads it.
final class ChatTests: XCTestCase {
    func testScheduleUnderstandsMinutesHoursAndDays() throws {
        let inHalf = try XCTUnwrap(ChatTimes.parseSchedule("30m call the bank"))
        XCTAssertEqual(inHalf.text, "call the bank")
        XCTAssertEqual(inHalf.at.timeIntervalSinceNow, 1800, accuracy: 5)
        let inTwo = try XCTUnwrap(ChatTimes.parseSchedule("2h ship it"))
        XCTAssertEqual(inTwo.at.timeIntervalSinceNow, 7200, accuracy: 5)
        let tomorrow = try XCTUnwrap(ChatTimes.parseSchedule("tomorrow standup notes"))
        XCTAssertEqual(Calendar.current.component(.hour, from: tomorrow.at), 9)
        XCTAssertTrue(Calendar.current.isDateInTomorrow(tomorrow.at))
        let monday = try XCTUnwrap(ChatTimes.parseSchedule("monday plan the week"))
        XCTAssertEqual(Calendar.current.component(.weekday, from: monday.at), 2)
        XCTAssertGreaterThan(monday.at, .now)
    }

    func testScheduleRefusesWhatItCannotRead() {
        XCTAssertNil(ChatTimes.parseSchedule("soon do it"))
        XCTAssertNil(ChatTimes.parseSchedule("30m"))
        XCTAssertNil(ChatTimes.parseSchedule("0h nothing"))
    }

    func testSlackMarksBecomeFormatting() {
        let text = ChatText.attributed("*bold* and _soft_ for @toru")
        XCTAssertEqual(String(text.characters), "bold and soft for @toru")
        let bold = text.runs.first { run in run.inlinePresentationIntent?.contains(.stronglyEmphasized) == true }
        XCTAssertEqual(bold.map { String(text[$0.range].characters) }, "bold")
    }

    func testMessageDecodesAsTheWorkerSendsIt() throws {
        let json = """
        {"id":"m1","channel":"b:shop","kind":"human","body":"hi","authorName":"Sarah","authorRef":"r1","mine":false,
         "createdAt":"2026-09-24T09:00:00.000Z","replyCount":2,"replyRefs":["r1"],"pinned":true,
         "reactions":[{"emoji":"✅","count":1,"refs":["r2"],"mine":true}]}
        """.data(using: .utf8)!
        let m = try JSONDecoder().decode(ChatMessage.self, from: json)
        XCTAssertEqual(m.channel, "b:shop")
        XCTAssertEqual(m.reactions?.first?.mine, true)
        XCTAssertFalse(m.isAI)
        XCTAssertFalse(m.isDeleted)
        XCTAssertEqual(m.date, ChatDates.parse("2026-09-24T09:00:00.000Z"))
    }

    func testFilesGroupsPrivateChannelsAndEmojiDecode() throws {
        let message = """
        {"id":"m2","channel":"g:0123456789abcdef","kind":"message","body":"","mine":true,"createdAt":"2026-09-26T01:00:00.000Z",
         "files":[{"id":"f_1","name":"menu.png","type":"image/png","size":2048,"width":400,"height":250,"url":"/files/f_1?e=1&s=ab"}]}
        """.data(using: .utf8)!
        let m = try JSONDecoder().decode(ChatMessage.self, from: message)
        let file = try XCTUnwrap(m.files?.first)
        XCTAssertTrue(file.isPicture)
        XCTAssertEqual(file.address(base: URL(string: "https://api.example.com")!)?.absoluteString, "https://api.example.com/files/f_1?e=1&s=ab")

        let business = try JSONDecoder().decode(ChatBusiness.self, from: #"{"slug":"payroll","name":"Payroll","private":true}"#.data(using: .utf8)!)
        XCTAssertEqual(business.isPrivate, true)
        let open = try JSONDecoder().decode(ChatBusiness.self, from: #"{"slug":"cafe","name":"Cafe"}"#.data(using: .utf8)!)
        XCTAssertNil(open.isPrivate)

        let overview = try JSONDecoder().decode(ChatOverview.self, from: #"{"activity":[],"members":[],"groups":[{"view":"g:0123456789abcdef","refs":["r1","r2"]}]}"#.data(using: .utf8)!)
        XCTAssertEqual(overview.groups?.first?.refs, ["r1", "r2"])

        let assets = ChatAssets(emoji: [ChatEmoji(name: "shogun_party", url: "https://api.example.com/emoji/img/emoji-1")], base: nil)
        XCTAssertNotNil(assets.emojiURL(":shogun_party:"))
        XCTAssertNil(assets.emojiURL(":other:"))
        XCTAssertNil(assets.emojiURL("👍"))
    }

    func testJamOpensTheWebAppOnTheConversationsJam() {
        let web = URL(string: "https://app.example.com")!
        XCTAssertEqual(ChatJamLink.jamURL(web: web, view: "b:kitchen")?.absoluteString, "https://app.example.com/#/jam/b:kitchen")
        XCTAssertEqual(ChatJamLink.jamURL(web: web, view: "g:0123456789abcdef")?.absoluteString, "https://app.example.com/#/jam/g:0123456789abcdef")
    }

    func testAnInvitationLinkOrItsCodeJoinsTheSameWorkspace() {
        XCTAssertEqual(WorkspaceDirectory.inviteCode(from: "https://app.example.com/#/join/0123abcd4567ef89"), "0123abcd4567ef89")
        XCTAssertEqual(WorkspaceDirectory.inviteCode(from: "  0123abcd4567ef89 "), "0123abcd4567ef89")
        let entry = try? JSONDecoder().decode(WorkspaceEntry.self, from: #"{"id":"personal:x","name":"ShogunAI","role":"admin","memberCount":7}"#.data(using: .utf8)!)
        XCTAssertEqual(entry?.label, "ShogunAI")
        XCTAssertEqual(entry?.memberCount, 7)
    }
}
