import XCTest
@testable import TikTokForWork

final class AppLocalizationTests: XCTestCase {
    @MainActor
    func testExplicitLanguageChangesCatalogStringsAndInterpolationInTheSameProcess() {
        let previous = UserDefaults.standard.string(forKey: "appLanguage")
        defer {
            UserDefaults.standard.set(previous, forKey: "appLanguage")
            Bundle.setAppLanguage(AppLanguage(rawValue: previous ?? "system")?.locale?.identifier)
        }
        UserDefaults.standard.set("ja", forKey: "appLanguage")
        Bundle.setAppLanguage("ja")
        XCTAssertEqual(String(localized: "Profile"), "プロフィール")
        XCTAssertEqual(String(localized: "Send another code in \(12)s"), "12秒後に再送できます")

        UserDefaults.standard.set("en", forKey: "appLanguage")
        Bundle.setAppLanguage("en")
        XCTAssertEqual(String(localized: "Profile"), "Profile")
        XCTAssertEqual(String(localized: "Send another code in \(12)s"), "Send another code in 12s")
    }

    @MainActor
    func testResettingTheDemoUsesTheNewLanguageForCardsAndPeople() {
        let app = AppState(startServices: false)
        let previous = app.language
        defer { app.language = previous }
        app.language = .japanese
        app.activateGuestSession()
        XCTAssertEqual(app.cardService.card(id: "demo-launch")?.title, "案内動画の再撮影費用 $1,840 を承認")
        XCTAssertEqual(app.workspaceMembers.first { $0.id == "demo-sarah" }?.role, "マーケティング責任者")

        app.language = .english
        app.resetDemoWorkspace()
        XCTAssertEqual(app.cardService.card(id: "demo-launch")?.title, "Approve $1,840 for the onboarding video reshoot")
        XCTAssertEqual(app.workspaceMembers.first { $0.id == "demo-sarah" }?.role, "Marketing Manager")
        XCTAssertEqual(app.currentUser?.name, "You")
    }

    /// Lists say how long ago to the minute — "10分前", "2時間38分前" — not
    /// the seconds ticking by ("10分50秒") that `Text(_, style: .relative)` drew.
    @MainActor
    func testTimeAgoIsMinutesAndHoursNeverSeconds() {
        let previous = UserDefaults.standard.string(forKey: "appLanguage")
        defer { Bundle.setAppLanguage(AppLanguage(rawValue: previous ?? "system")?.locale?.identifier) }
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let ago = { (seconds: TimeInterval, locale: String) in
            DateFormatting.ago(now.addingTimeInterval(-seconds), now: now, locale: Locale(identifier: locale))
        }

        Bundle.setAppLanguage("ja")
        let tenMinutes = ago(10 * 60 + 50, "ja")
        XCTAssertTrue(tenMinutes.contains("10") && tenMinutes.hasSuffix("前"), tenMinutes)
        XCTAssertFalse(tenMinutes.contains("秒") || tenMinutes.contains("50"), tenMinutes)
        let hoursAndMinutes = ago(2 * 3600 + 38 * 60 + 12, "ja")
        XCTAssertTrue(hoursAndMinutes.contains("2") && hoursAndMinutes.contains("38") && hoursAndMinutes.hasSuffix("前"), hoursAndMinutes)
        XCTAssertFalse(hoursAndMinutes.contains("秒") || hoursAndMinutes.contains("12"), hoursAndMinutes)
        XCTAssertFalse(ago(20, "ja").contains("20"), ago(20, "ja"))

        Bundle.setAppLanguage("en")
        let english = ago(2 * 3600 + 38 * 60, "en")
        XCTAssertTrue(english.contains("2") && english.contains("38") && english.hasSuffix("ago"), english)
        XCTAssertFalse(english.contains("sec"), english)
        XCTAssertTrue(ago(3 * 86_400, "en").contains("3"), ago(3 * 86_400, "en"))
    }
}
