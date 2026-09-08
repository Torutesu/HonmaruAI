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
}
