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
        app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        XCTAssertTrue(app.buttons["Get started"].waitForExistence(timeout: 20))
        app.buttons["Get started"].tap()
        app.buttons["Continue"].tap()
        app.buttons["Approve"].tap()
        app.buttons["Continue"].tap()
        app.buttons["Sign in with email"].tap()
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
        let reachedShell = app.buttons["Create"].waitForExistence(timeout: 25)
        XCTAssertTrue(reachedShell, "Actual sign-in callback must reach the app shell")
        guard reachedShell else { return }
        let joinedWorkspace = app.staticTexts["No decisions yet. Tell your AI something, or wait for a teammate."].waitForExistence(timeout: 25)
        XCTAssertTrue(joinedWorkspace, "Authenticated workspace must join, not show No access")
        guard joinedWorkspace else { return }
        XCTAssertFalse(app.staticTexts["No access"].exists)
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Ordinary account signed in and joined its real workspace"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        app.terminate()
        app.launch()
        XCTAssertTrue(app.buttons["Create"].waitForExistence(timeout: 25), "Saved session must survive relaunch")
        XCTAssertTrue(app.staticTexts["No decisions yet. Tell your AI something, or wait for a teammate."].waitForExistence(timeout: 25))
        app.terminate()
    }

    @MainActor
    func testFirstLaunchEmailAndTextDraftWithoutPermissions() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        XCTAssertTrue(app.buttons["Get started"].waitForExistence(timeout: 20))
        app.buttons["Get started"].tap()
        app.buttons["Continue"].tap()
        XCTAssertTrue(app.buttons["Approve"].waitForExistence(timeout: 5))
        app.buttons["Approve"].tap()
        XCTAssertTrue(app.buttons["Continue"].waitForExistence(timeout: 5))
        app.buttons["Continue"].tap()
        XCTAssertTrue(app.buttons["Sign in with email"].waitForExistence(timeout: 5))
        app.buttons["Sign in with email"].tap()
        XCTAssertTrue(app.buttons["Use a password instead"].waitForExistence(timeout: 5))
        app.buttons["Use a password instead"].tap()
        XCTAssertTrue(app.secureTextFields.firstMatch.waitForExistence(timeout: 5))
        app.navigationBars.buttons["Back"].tap()
        app.navigationBars.buttons["Cancel"].tap()
        app.buttons["Continue without signing in"].tap()
        XCTAssertTrue(app.buttons["Create"].waitForExistence(timeout: 5))
        app.buttons["Create"].tap()
        app.buttons["Write a request"].tap()
        let editor = app.textViews.firstMatch
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        editor.tap()
        editor.typeText("Review the release checklist")
        // Keyboard can cover the bottom action in the medium sheet.
        app.swipeUp()
        let draftButton = app.buttons.matching(NSPredicate(format: "label IN %@", ["Draft in background", "Draft card"])).firstMatch
        XCTAssertTrue(draftButton.waitForExistence(timeout: 5))
        draftButton.tap()
        XCTAssertTrue(app.buttons["Continue without AI"].waitForExistence(timeout: 5))
        app.buttons["Continue without AI"].tap()
        XCTAssertTrue(app.navigationBars["Review card"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.descendants(matching: .any)["draft.title"].exists)
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "Editable draft without microphone or AI permission"
        attachment.lifetime = .keepAlways
        add(attachment)
        app.buttons["Discard"].tap()
        app.buttons.matching(identifier: "You").firstMatch.tap()
        XCTAssertTrue(app.buttons["Plan"].waitForExistence(timeout: 5))
        app.buttons["Plan"].tap()
        let terms = app.buttons["Terms of Use"]
        XCTAssertTrue(terms.waitForExistence(timeout: 5) || app.links["Terms of Use"].exists)
        XCTAssertTrue(app.buttons["Privacy Policy"].exists || app.links["Privacy Policy"].exists)
        let legal = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        legal.name = "Legal links remain available on the plan screen"
        legal.lifetime = .keepAlways
        add(legal)
    }
}
