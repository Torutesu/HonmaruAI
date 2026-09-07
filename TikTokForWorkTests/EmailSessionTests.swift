import XCTest
@testable import TikTokForWork

/// Email sign-in adds a second kind of session, and the two restore along
/// different paths on launch. These pin the parts that decide which path a
/// launch takes, and the name a person sees before the server has told us one.
final class EmailSessionTests: XCTestCase {
    @MainActor
    private func clean() {
        SessionStore.clear()
        addTeardownBlock { @MainActor in SessionStore.clear() }
    }

    @MainActor
    func testEmailSessionIsRecognisedWhenThereIsNoRepository() {
        clean()
        SessionStore.sessionToken = "tok"
        SessionStore.currentUserID = "u:mai@honmaru.jp"
        SessionStore.orgId = "personal:abc123"

        XCTAssertTrue(SessionStore.hasSavedEmailSession)
        XCTAssertFalse(SessionStore.hasSavedGitHubSession)
    }

    @MainActor
    func testAGitHubSessionIsNotMistakenForAnEmailOne() {
        clean()
        SessionStore.sessionToken = "tok"
        SessionStore.currentUserID = "octocat"
        SessionStore.githubRepository = "acme/app"

        // Both would otherwise be true, and restore would take the wrong path:
        // an email restore skips validating the repository the session is for.
        XCTAssertFalse(SessionStore.hasSavedEmailSession)
        XCTAssertTrue(SessionStore.hasSavedGitHubSession)
    }

    @MainActor
    func testSigningOutForgetsTheOrganization() {
        clean()
        SessionStore.sessionToken = "tok"
        SessionStore.currentUserID = "u:mai@honmaru.jp"
        SessionStore.orgId = "personal:abc123"

        SessionStore.clear()

        // Left behind, the next account on this phone would adopt the previous
        // one's organization before the server ever named theirs.
        XCTAssertNil(SessionStore.orgId)
        XCTAssertFalse(SessionStore.hasSavedEmailSession)
    }

    func testARelayLoginReadsAsAName() {
        XCTAssertEqual(AppState.readableLogin("u:mai@honmaru.jp"), "mai")
        XCTAssertEqual(AppState.readableLogin("email:ken@example.com"), "ken")
        XCTAssertEqual(AppState.readableLogin("octocat"), "octocat")
    }
}
