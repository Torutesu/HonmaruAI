import XCTest
@testable import TikTokForWork

/// The daily report on the phone: a draft read off the relay, the only way
/// it leaves (Post), the setup's defaults, and the words sent to the Worker.
final class DailyReportTests: XCTestCase {
    private func card(status: String, cardStatus: String = "pending") throws -> DecisionCard {
        let json = """
        {"id":"daily-1","recipientUserID":"toru","senderUserID":"toru","type":"notification","format":"fyi",
         "title":"日報 2026-09-24","summary":"確認して #daily-reports に投稿してください。","context":"",
         "status":"\(cardStatus)","priority":"high","createdAt":"2026-09-24T13:00:00.123Z",
         "report":{"markdown":"x","routineId":"r"},
         "dailyReport":{"routineId":"r","part":"evening","channel":"b:daily-reports","date":"2026-09-24",
                        "status":"\(status)","text":"*今日やったこと*\\n- （自分の言葉で書いてください）\\n*反省点*\\n- （自分の言葉で書いてください）",
                        "fillIn":"（自分の言葉で書いてください）"}}
        """
        return try JSONDecoder.relay().decode(DecisionCard.self, from: Data(json.utf8))
    }

    func testADraftIsReadOffTheRelayAndOnlyPostTakesItAway() throws {
        let draft = try card(status: "draft")
        let report = try XCTUnwrap(draft.dailyReport)
        XCTAssertTrue(draft.awaitsPost)
        XCTAssertEqual(report.channelName, "#daily-reports")
        XCTAssertFalse(report.isMorning)
        XCTAssertEqual(report.unwrittenLines(in: report.text), 2)
        XCTAssertEqual(report.unwrittenLines(in: "done"), 0)
        XCTAssertTrue(try card(status: "posting").awaitsPost)
        XCTAssertFalse(try card(status: "posted", cardStatus: "completed").awaitsPost)
        XCTAssertFalse(try card(status: "expired", cardStatus: "completed").awaitsPost)
    }

    func testAnOrdinaryCardIsNotADraft() throws {
        let json = #"{"id":"c","recipientUserID":"a","senderUserID":"b","type":"approval","title":"t","summary":"s","context":"","status":"pending","priority":"low","createdAt":"2026-09-24T13:00:00Z"}"#
        let plain = try JSONDecoder.relay().decode(DecisionCard.self, from: Data(json.utf8))
        XCTAssertNil(plain.dailyReport)
        XCTAssertFalse(plain.awaitsPost)
    }

    func testThePostGoesOutTheWayTheWorkerReadsIt() throws {
        let data = try JSONEncoder().encode(DailyReportService.Outgoing(orgId: "personal:toru", cardId: "daily-1", text: "*今日やったこと*\n- 採用を決めた"))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
        XCTAssertEqual(json, ["orgId": "personal:toru", "cardId": "daily-1", "text": "*今日やったこと*\n- 採用を決めた"])
        XCTAssertEqual(DailyReportService.message(in: Data(#"{"message":"This report has already been posted."}"#.utf8)), "This report has already been posted.")
        XCTAssertEqual(DailyReportService.message(in: Data("<html>".utf8)), String(localized: "That did not save."))
    }

    func testTheRoutinesAreReadAsTheWorkerListsThem() throws {
        let json = #"{"id":"r1","kind":"daily_plan","title":"朝の予定","instruction":"x","cadence":"weekdays","weekday":null,"monthday":null,"hour":8,"minute":0,"timezone":"Asia/Tokyo","schedule":"平日 08:00","enabled":true,"nextRunAt":null,"channel":"b:日報","mine":true}"#
        let routine = try JSONDecoder().decode(DailyReportService.Routine.self, from: Data(json.utf8))
        XCTAssertEqual(DailyReportService.Part(rawValue: routine.kind), .morning)
        XCTAssertEqual(routine.channel, "b:日報")
        XCTAssertEqual(DailyReportService.Part.morning.defaultHour, 8)
        XCTAssertEqual(DailyReportService.Part.evening.defaultHour, 22)
        XCTAssertNil(DailyReportService.Part(rawValue: "report"))
    }

    func testTheSetupStartsAtEightAndTenAndReadsTimesBack() {
        let evening = DailyReportSetupView.hourAndMinute(DailyReportSetupView.time(22, 0))
        XCTAssertEqual(evening.hour, 22)
        XCTAssertEqual(evening.minute, 0)
        let morning = DailyReportSetupView.hourAndMinute(DailyReportSetupView.time(7, 45))
        XCTAssertEqual(morning.hour, 7)
        XCTAssertEqual(morning.minute, 45)
    }

    @MainActor
    func testTheChannelItProposesIsOneItRecognisesInEveryLanguage() {
        let previous = UserDefaults.standard.string(forKey: "appLanguage")
        defer {
            UserDefaults.standard.set(previous, forKey: "appLanguage")
            Bundle.setAppLanguage(AppLanguage(rawValue: previous ?? "system")?.locale?.identifier)
        }
        for code in ["en", "ja", "es", "fr", "de"] {
            UserDefaults.standard.set(code, forKey: "appLanguage")
            Bundle.setAppLanguage(code)
            XCTAssertTrue(DailyReportService.channelSlugs.contains(String(localized: "daily-reports")), code)
        }
    }
}
