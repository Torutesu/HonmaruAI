import XCTest
@testable import TikTokForWork

final class SessionRecoveryTests: XCTestCase {
    func testOfflineLaunchAndTemporaryServerFailuresKeepSavedLogin() {
        let retryable: [GitHubServiceError] = [
            .network(URLError(.notConnectedToInternet)),
            .network(URLError(.timedOut)),
            .api(statusCode: 403, message: "API rate limit exceeded"),
            .api(statusCode: 429, message: "Too many requests"),
            .api(statusCode: 502, message: "Bad gateway"),
            .invalidRepository
        ]
        for error in retryable { XCTAssertFalse(error.invalidatesSavedSession, "\(error)") }
    }

    func testRevokedOrMissingCredentialsRequireSignIn() {
        XCTAssertTrue(GitHubServiceError.unauthorized.invalidatesSavedSession)
        XCTAssertTrue(GitHubServiceError.missingCredentials.invalidatesSavedSession)
        XCTAssertTrue(GitHubServiceError.api(statusCode: 401, message: "Session expired").invalidatesSavedSession)
    }

    @MainActor
    func testAnEmptyRelaySnapshotRemovesCardsDeletedOnAnotherDevice() {
        let service = DecisionCardService()
        service.setActiveUser("alice")
        let card = DecisionCard(id: "deleted-elsewhere", recipientUserID: "alice", senderUserID: "bob",
                                type: .approval, title: "Old decision", summary: "", context: "",
                                status: .pending, priority: .high, createdAt: .now)
        service.applySnapshot(["alice": [card]])
        XCTAssertEqual(service.pendingCount, 1)
        service.applySnapshot([:])
        XCTAssertEqual(service.pendingCount, 0)
        XCTAssertTrue(service.cards(for: "alice").isEmpty)
    }
}
