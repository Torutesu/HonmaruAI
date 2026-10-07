import XCTest
@testable import TikTokForWork

@MainActor
final class AIDataConsentTests: XCTestCase {
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
