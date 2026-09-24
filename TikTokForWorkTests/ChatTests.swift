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
}
