import XCTest
@testable import TikTokForWork

/// Email sign-in adds a second kind of session, and the two restore along
/// different paths on launch. What is worth pinning is the rule that picks the
/// path — not the keychain's ability to persist it, which a test bundle cannot
/// rely on and which would make every one of these pass for the wrong reason.
final class EmailSessionTests: XCTestCase {
    func testRestoreUsesServerWorkspaceAndIdentity() throws {
        let data = Data(#"{"login":"member","userId":"email:member@example.com","orgId":"joined-team"}"#.utf8)
        let restored = try EmailAuthService.decodeRestoredSession(data, status: 200, token: "saved-token")
        XCTAssertEqual(restored.orgId, "joined-team")
        XCTAssertEqual(restored.userID, "email:member@example.com")
        XCTAssertEqual(restored.token, "saved-token")
    }

    func testRestoreWithoutMembershipDoesNotInventWorkspace() throws {
        let data = Data(#"{"login":"member","userId":"email:member@example.com","orgId":null}"#.utf8)
        XCTAssertEqual(try EmailAuthService.decodeRestoredSession(data, status: 200, token: "token").orgId, "")
    }

    func testOnlyExplicitSessionFailureRequiresSignIn() {
        for status in [401, 409] {
            XCTAssertThrowsError(try EmailAuthService.decodeRestoredSession(Data(), status: status, token: "token")) { error in
                guard case EmailAuthService.Failure.invalidSession = error else { return XCTFail("Expected invalid session") }
            }
        }
        for status in [403, 429, 500, 503, 200] {
            XCTAssertThrowsError(try EmailAuthService.decodeRestoredSession(Data(), status: status, token: "token")) { error in
                if case EmailAuthService.Failure.invalidSession = error { XCTFail("Must preserve saved session") }
            }
        }
    }

    func testASessionWithNoRepositoryIsAnEmailOne() {
        XCTAssertTrue(SessionStore.isEmailSession(token: "tok", user: "u:mai@honmaru.jp", repository: nil))
        XCTAssertTrue(SessionStore.isEmailSession(token: "tok", user: "u:mai@honmaru.jp", repository: ""))
    }

    func testAGitHubSessionIsNotMistakenForAnEmailOne() {
        // Both would otherwise look true, and restore would take the wrong
        // path: the email path skips validating the repository the session is
        // for, so a stale repository would go unnoticed until something failed.
        XCTAssertFalse(SessionStore.isEmailSession(token: "tok", user: "octocat", repository: "acme/app"))
        XCTAssertTrue(SessionStore.isGitHubSession(token: "tok", repository: "acme/app"))
    }

    func testNeitherKindSurvivesAMissingToken() {
        XCTAssertFalse(SessionStore.isEmailSession(token: nil, user: "u:mai@honmaru.jp", repository: nil))
        XCTAssertFalse(SessionStore.isEmailSession(token: "", user: "u:mai@honmaru.jp", repository: nil))
        XCTAssertFalse(SessionStore.isGitHubSession(token: nil, repository: "acme/app"))
        XCTAssertFalse(SessionStore.isGitHubSession(token: "", repository: "acme/app"))
    }

    func testAnEmailSessionNeedsAPersonToBe() {
        // The login is what the relay is joined as. Without it there is a token
        // and nobody to spend it on.
        XCTAssertFalse(SessionStore.isEmailSession(token: "tok", user: nil, repository: nil))
        XCTAssertFalse(SessionStore.isEmailSession(token: "tok", user: "", repository: nil))
    }

    func testAGitHubSessionWithoutARepositoryIsNoSession() {
        XCTAssertFalse(SessionStore.isGitHubSession(token: "tok", repository: nil))
        XCTAssertFalse(SessionStore.isGitHubSession(token: "tok", repository: ""))
    }

    func testSigningOutForgetsTheOrganizationAndTheToken() {
        // Left behind, the organization would have the next account on this
        // phone adopt the previous one's before the server ever named theirs.
        XCTAssertTrue(SessionStore.clearedKeys.contains("orgId"))
        XCTAssertTrue(SessionStore.clearedKeys.contains("sessionToken"))
        XCTAssertTrue(SessionStore.clearedKeys.contains("currentUserID"))
        XCTAssertTrue(SessionStore.clearedKeys.contains("githubRepository"))
        // The person's own OpenAI key belongs to the device, not the session.
        XCTAssertFalse(SessionStore.clearedKeys.contains("apiKey"))
    }

    func testAnEmailTransitionClearsGitHubFieldsWithoutDeletingItsFreshToken() {
        XCTAssertTrue(SessionStore.githubConnectionKeys.contains("githubRepository"))
        XCTAssertTrue(SessionStore.githubConnectionKeys.contains("githubUsername"))
        XCTAssertFalse(SessionStore.githubConnectionKeys.contains("sessionToken"))
        XCTAssertFalse(SessionStore.githubConnectionKeys.contains("orgId"))
        XCTAssertTrue(SessionStore.clearedKeys.contains("accountID"))
    }

    func testEmailResponseKeepsServerIdentityAndAllowsMembershipLessAccounts() throws {
        let session = try EmailAuthService.decodeSession(["token": "tok", "login": "u:mai@example.com", "userId": "email:mai@example.com", "orgId": NSNull()])
        XCTAssertEqual(session.login, "u:mai@example.com")
        XCTAssertEqual(session.userID, "email:mai@example.com")
        XCTAssertTrue(session.orgId.isEmpty)
        XCTAssertThrowsError(try EmailAuthService.decodeSession(["token": "tok", "orgId": "acme/app"]))
    }

    func testARelayLoginReadsAsAName() {
        XCTAssertEqual(AppState.readableLogin("u:mai@honmaru.jp"), "mai")
        XCTAssertEqual(AppState.readableLogin("email:ken@example.com"), "ken")
        XCTAssertEqual(AppState.readableLogin("octocat"), "octocat")
    }
}
