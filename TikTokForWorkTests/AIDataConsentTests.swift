import XCTest
@testable import TikTokForWork

@MainActor
final class AIDataConsentTests: XCTestCase {
    override func setUp() async throws {
        try await super.setUp()
        // The keychain outlives a test run; a grant left by an earlier one
        // must not answer this run's question.
        SessionStore.clear()
    }

    func testConsentBelongsToOneSignInAndSignOutForgetsIt() {
        let mark = SessionStore.consentMark(forSessionToken: "session-a")
        XCTAssertEqual(mark, SessionStore.consentMark(forSessionToken: "session-a"))
        XCTAssertNotEqual(mark, SessionStore.consentMark(forSessionToken: "session-b"))
        XCTAssertFalse(mark.contains("session-a"), "The mark is a hash, not the token")
        SessionStore.aiConsentSession = mark
        XCTAssertTrue(SessionStore.clearedKeys.contains("aiConsentSession"))
        SessionStore.clear()
        XCTAssertNil(SessionStore.aiConsentSession)
    }

    func testAnotherSignInsGrantDoesNotAnswerForThisOne() async {
        SessionStore.aiConsentSession = SessionStore.consentMark(forSessionToken: "an-earlier-session")
        let app = AppState(startServices: false)
        let activation = Task { await app.activateEmailSession(login: "consent-test", orgId: "private-workspace", name: nil, sessionToken: "non-network-test-token") }
        while !app.isAwaitingAIConsent { await Task.yield() }
        app.resolveAIConsent(false)
        await activation.value
        XCTAssertFalse(app.isAuthenticated)
        XCTAssertNil(SessionStore.aiConsentSession)
    }

    func testDecliningConsentDoesNotActivateWorkspace() async {
        let app = AppState(startServices: false)
        let activation = Task { await app.activateEmailSession(login: "consent-test", orgId: "private-workspace", name: nil, sessionToken: "non-network-test-token") }
        while !app.isAwaitingAIConsent { await Task.yield() }
        XCTAssertFalse(app.isAuthenticated)
        XCTAssertNil(app.currentUser)
        app.resolveAIConsent(false)
        await activation.value
        XCTAssertFalse(app.isAwaitingAIConsent)
        XCTAssertFalse(app.isAuthenticated)
        XCTAssertNil(app.currentUser)
        XCTAssertNotEqual(app.connectionState, .connected)
        XCTAssertNil(SessionStore.sessionToken)
    }

    func testSignOutWhileConsentIsPendingCannotActivateOldSession() async {
        let app = AppState(startServices: false)
        let activation = Task { await app.activateEmailSession(login: "old-user", orgId: "private-workspace", name: nil, sessionToken: "non-network-test-token") }
        while !app.isAwaitingAIConsent { await Task.yield() }
        app.signOut()
        app.resolveAIConsent(true) // A stale button action cannot grant access.
        await activation.value
        XCTAssertFalse(app.isAuthenticated)
        XCTAssertNil(app.currentUser)
        XCTAssertNotEqual(app.connectionState, .connected)
    }
}
