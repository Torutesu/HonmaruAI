import XCTest

final class ReviewFlowUITests: XCTestCase {
    @MainActor
    func testJapaneseChatShortcutsRemainReadable() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-disableUpdateCheck", "YES", "-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP", "-appLanguage", "ja",
                               "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryL"]
        app.launch()
        let demo = app.buttons["デモを試す"]
        XCTAssertTrue(demo.waitForExistence(timeout: 20))
        demo.tap()
        // Slack's four places sit in the tab bar, each label on one line.
        for title in ["ホーム", "DM", "アクティビティ", "あなた"] {
            let tab = app.buttons[title].firstMatch
            XCTAssertTrue(tab.waitForExistence(timeout: 15), title)
            XCTAssertLessThanOrEqual(tab.frame.height, 64, title)
        }
        // Home as a list is Slack's sidebar: the cards along the top.
        let list = app.buttons["リスト"].firstMatch
        XCTAssertTrue(list.waitForExistence(timeout: 10))
        list.tapShowingTheScreen(in: app)
        for title in ["スレッド", "後で"] {
            let card = app.buttons[title].firstMatch
            XCTAssertTrue(card.waitForExistence(timeout: 5), title)
            XCTAssertTrue(card.isHittable, title)
            // A shortcut must not turn into a tall column of single
            // characters on a small iPhone (Japanese labels are longer).
            XCTAssertLessThanOrEqual(card.frame.height, 120, title)
            XCTAssertGreaterThanOrEqual(card.frame.width, 100, title)
            XCTAssertTrue(app.frame.contains(card.frame), title)
        }
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Japanese Slack-style home fits the phone"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        app.buttons["スレッド"].firstMatch.tapShowingTheScreen(in: app)
        XCTAssertTrue(app.navigationBars["スレッド"].waitForExistence(timeout: 5))
        app.terminate()
    }

    @MainActor
    func testOrdinaryAccountCanSignInThroughTheActualUI() async throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["HONMARU_LIVE_AUTH_TEST"] == "1", "Live UI account lifecycle is opt-in")
        continueAfterFailure = false
        let base = URL(string: "https://tiktokforwork.torubj0904.workers.dev")!
        let email = "ui-qa-\(UUID().uuidString.lowercased())@example.invalid"
        let password = UUID().uuidString
        var signup = URLRequest(url: base.appendingPathComponent("auth/signup"))
        signup.httpMethod = "POST"
        signup.timeoutInterval = 30
        signup.setValue("application/json", forHTTPHeaderField: "Content-Type")
        signup.httpBody = try JSONSerialization.data(withJSONObject: ["email": email, "password": password, "name": "UI QA", "locale": "en"])
        let (data, response) = try await URLSession.shared.data(for: signup)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let token = try XCTUnwrap(json["token"] as? String)
        addTeardownBlock {
            var request = URLRequest(url: base.appendingPathComponent("account"))
            request.httpMethod = "DELETE"
            request.timeoutInterval = 30
            request.setValue(token, forHTTPHeaderField: "x-session-token")
            let (_, response) = try await URLSession.shared.data(for: request)
            XCTAssertTrue([200, 401].contains((response as? HTTPURLResponse)?.statusCode ?? 0), "Delete the disposable UI account or confirm its session was revoked")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-disableUpdateCheck", "YES", "-AppleLanguages", "(en)", "-AppleLocale", "en_US", "-appLanguage", "en", "-home.list", "NO",
                               "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryL"]
        app.launch()
        XCTAssertTrue(app.buttons["Get started"].waitForExistence(timeout: 20))
        app.buttons["Get started"].tap()
        let passwordOption = app.buttons["Use a password instead"]
        XCTAssertTrue(passwordOption.waitForExistence(timeout: 5))
        app.scrollViews.firstMatch.swipeUp()
        passwordOption.tap()
        let passwordField = app.secureTextFields.firstMatch
        let passwordScreenVisible = passwordField.waitForExistence(timeout: 5)
        XCTAssertTrue(passwordScreenVisible)
        guard passwordScreenVisible else { return }
        let emailField = app.textFields.firstMatch
        XCTAssertTrue(emailField.waitForExistence(timeout: 5))
        emailField.tap()
        emailField.typeText(email)
        passwordField.tap()
        passwordField.typeText(password)
        app.swipeUp()
        app.buttons["Sign in"].tap()
        let consent = app.buttons["aiConsent.allow"]
        XCTAssertTrue(consent.waitForExistence(timeout: 15), "Sharing must be explained before workspace access")
        XCTAssertFalse(app.buttons["New request"].exists)
        let disclosure = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        disclosure.name = "AI data disclosure before workspace access"
        disclosure.lifetime = .keepAlways
        add(disclosure)
        for _ in 0..<6 where !consent.isHittable { app.swipeUp() }
        consent.tapShowingTheScreen(in: app)
        let reachedShell = app.buttons["New request"].waitForExistence(timeout: 25)
        XCTAssertTrue(reachedShell, "Actual sign-in callback must reach the app shell")
        guard reachedShell else { return }
        // A prior UI test may have selected the list layout; launch arguments
        // reset that preference. Dismiss new-account setup on either launch.
        let initialLater = app.navigationBars.buttons["Later"]
        if initialLater.waitForExistence(timeout: 5) { initialLater.tap() }
        let joinedWorkspace = app.staticTexts["You're all caught up"].waitForExistence(timeout: 25)
        XCTAssertTrue(joinedWorkspace, "Authenticated workspace must join, not show No access")
        guard joinedWorkspace else { return }
        XCTAssertFalse(app.staticTexts["No access"].exists)
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Ordinary account signed in and joined its real workspace"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        app.terminate()
        app.launch()
        XCTAssertTrue(consent.waitForExistence(timeout: 25), "Restored sessions must ask before reconnecting the workspace")
        for _ in 0..<6 where !consent.isHittable { app.swipeUp() }
        consent.tapShowingTheScreen(in: app)
        XCTAssertTrue(app.buttons["New request"].waitForExistence(timeout: 25), "Saved session must survive relaunch after consent")
        // New accounts are offered daily-report setup after the workspace
        // finishes loading, including when that finishes on the next launch.
        let later = app.navigationBars.buttons["Later"]
        if later.waitForExistence(timeout: 5) { later.tap() }
        XCTAssertTrue(app.staticTexts["You're all caught up"].waitForExistence(timeout: 25))
        app.buttons.matching(identifier: "You").firstMatch.tapShowingTheScreen(in: app)
        let deletion = app.buttons["profile.deleteAccount"]
        XCTAssertTrue(deletion.waitForExistence(timeout: 5))
        XCTAssertTrue(deletion.isHittable, "Account deletion must be directly visible on the profile")
        let profile = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        profile.name = "Account deletion is directly visible on the profile"
        profile.lifetime = .keepAlways
        add(profile)
        deletion.tap()
        let confirmation = app.textFields["account.deleteConfirmation"]
        XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
        let submit = app.buttons["account.deleteSubmit"]
        XCTAssertFalse(submit.isEnabled, "Opening the screen must not delete the account")
        confirmation.tap()
        confirmation.typeText("DELETE")
        app.swipeUp()
        XCTAssertTrue(submit.isEnabled)
        let deletionScreen = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        deletionScreen.name = "In-app account deletion confirmation"
        deletionScreen.lifetime = .keepAlways
        add(deletionScreen)
        submit.tapShowingTheScreen(in: app)
        XCTAssertTrue(app.buttons["Get started"].waitForExistence(timeout: 25), "Deleting the account returns to signed-out onboarding")
        var me = URLRequest(url: base.appendingPathComponent("me"))
        me.setValue(token, forHTTPHeaderField: "x-session-token")
        let (_, deletedResponse) = try await URLSession.shared.data(for: me)
        XCTAssertEqual((deletedResponse as? HTTPURLResponse)?.statusCode, 401, "Deletion revokes the server session")
        app.terminate()
    }

    @MainActor
    func testFirstLaunchEmailAndTextDraftWithoutPermissions() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-disableUpdateCheck", "YES", "-AppleLanguages", "(en)", "-AppleLocale", "en_US", "-appLanguage", "en", "-home.list", "NO",
                               "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryL"]
        app.launch()
        XCTAssertTrue(app.buttons["Get started"].waitForExistence(timeout: 20))
        app.buttons["Get started"].tap()
        XCTAssertTrue(app.buttons["Use a password instead"].waitForExistence(timeout: 5))
        app.scrollViews.firstMatch.swipeUp()
        app.buttons["Use a password instead"].tap()
        XCTAssertTrue(app.secureTextFields.firstMatch.waitForExistence(timeout: 5))
        app.navigationBars.buttons["Back"].tap()
        app.navigationBars.buttons["Cancel"].tap()
        app.buttons["Try the demo"].tap()
        XCTAssertTrue(app.buttons["New request"].waitForExistence(timeout: 5))
        let home = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        home.name = "Integrated Figma home from the actual application"
        home.lifetime = .keepAlways
        add(home)
        app.buttons["New request"].tapShowingTheScreen(in: app)
        app.buttons["Write"].tapShowingTheScreen(in: app)
        let editor = app.textViews.firstMatch
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        editor.tap()
        editor.typeText("Review the release checklist")
        // Keyboard can cover the bottom action in the medium sheet.
        app.swipeUp()
        let draftButton = app.buttons["request.primary"]
        XCTAssertTrue(draftButton.waitForExistence(timeout: 5))
        draftButton.tap()
        XCTAssertTrue(app.navigationBars["Review request"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Review the release checklist"].firstMatch.exists)
        app.buttons["request.recipient"].tapShowingTheScreen(in: app)
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Mika Tanaka")).firstMatch.tapShowingTheScreen(in: app)
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "Editable draft without microphone or AI permission"
        attachment.lifetime = .keepAlways
        add(attachment)
        app.buttons["request.primary"].tapShowingTheScreen(in: app)
        XCTAssertTrue(app.alerts["Demo request created"].waitForExistence(timeout: 8))
        app.alerts.buttons["View history"].tap()
        XCTAssertTrue(app.navigationBars["History"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Review the release checklist"].firstMatch.exists)
        let history = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        history.name = "Sent request is visible in actual History"
        history.lifetime = .keepAlways
        add(history)
        app.navigationBars.buttons["Close"].tapShowingTheScreen(in: app)
        app.buttons.matching(identifier: "You").firstMatch.tapShowingTheScreen(in: app)
        let plan = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Plan and usage")).firstMatch
        XCTAssertTrue(plan.waitForExistence(timeout: 5))
        app.swipeUp()
        plan.tapShowingTheScreen(in: app)
        let terms = app.buttons["Terms of Use"]
        XCTAssertTrue(terms.waitForExistence(timeout: 5) || app.links["Terms of Use"].exists)
        XCTAssertTrue(app.buttons["Privacy Policy"].exists || app.links["Privacy Policy"].exists)
        let legal = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        legal.name = "Legal links remain available on the plan screen"
        legal.lifetime = .keepAlways
        add(legal)
    }
}

extension XCUIElement {
    /// A tap that, when the element is not hittable, first prints the
    /// screen's tree to the log — so whatever covers it shows in CI's "What
    /// the UI tests saw" step. (It found the App Store's update sheet over
    /// the home screen once 1.2.1 shipped.)
    func tapShowingTheScreen(in app: XCUIApplication) {
        if !isHittable { print("tapShowingTheScreen: not hittable: \(self)\n\(app.debugDescription)") }
        tap()
    }
}
