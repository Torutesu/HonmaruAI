import XCTest

final class ReviewFlowUITests: XCTestCase {
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
        signup.httpBody = try JSONSerialization.data(withJSONObject: ["email": email, "password": password, "name": "UI QA"])
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
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200, "Delete the disposable UI account")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US", "-appLanguage", "en"]
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
        let reachedShell = app.buttons["New request"].waitForExistence(timeout: 25)
        XCTAssertTrue(reachedShell, "Actual sign-in callback must reach the app shell")
        guard reachedShell else { return }
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
        XCTAssertTrue(app.buttons["New request"].waitForExistence(timeout: 25), "Saved session must survive relaunch")
        XCTAssertTrue(app.staticTexts["You're all caught up"].waitForExistence(timeout: 25))
        app.terminate()
    }

    @MainActor
    func testFirstLaunchEmailAndTextDraftWithoutPermissions() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US", "-appLanguage", "en"]
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
        app.buttons["New request"].tap()
        app.buttons["Write"].tap()
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
        app.buttons["request.recipient"].tap()
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Mika Tanaka")).firstMatch.tap()
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "Editable draft without microphone or AI permission"
        attachment.lifetime = .keepAlways
        add(attachment)
        app.buttons["request.primary"].tap()
        XCTAssertTrue(app.alerts["Demo request created"].waitForExistence(timeout: 8))
        app.alerts.buttons["View history"].tap()
        XCTAssertTrue(app.navigationBars["History"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Review the release checklist"].firstMatch.exists)
        let history = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        history.name = "Sent request is visible in actual History"
        history.lifetime = .keepAlways
        add(history)
        app.navigationBars.buttons["Close"].tap()
        app.buttons.matching(identifier: "You").firstMatch.tap()
        let plan = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Plan and usage")).firstMatch
        XCTAssertTrue(plan.waitForExistence(timeout: 5))
        app.swipeUp()
        plan.tap()
        let terms = app.buttons["Terms of Use"]
        XCTAssertTrue(terms.waitForExistence(timeout: 5) || app.links["Terms of Use"].exists)
        XCTAssertTrue(app.buttons["Privacy Policy"].exists || app.links["Privacy Policy"].exists)
        let legal = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        legal.name = "Legal links remain available on the plan screen"
        legal.lifetime = .keepAlways
        add(legal)
    }
}
