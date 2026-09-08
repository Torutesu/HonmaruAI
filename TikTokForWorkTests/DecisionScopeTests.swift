import XCTest
@testable import TikTokForWork

@MainActor
private final class DelayedGitHubSync: DecisionGitHubSyncing {
    let isConnected = true
    let linkedRepository = "acme/old"
    var didStart: (() -> Void)?
    var continuation: CheckedContinuation<(number: Int, url: String), Error>?

    func syncDecision(_ card: DecisionCard) async throws -> (number: Int, url: String) {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            didStart?()
        }
    }

    func issueState(number: Int) async throws -> String { "open" }
}

final class DecisionScopeTests: XCTestCase {
    @MainActor
    func testAnApprovalFinishingAfterSignOutCannotRepopulateTheNewAccount() async throws {
        let service = DecisionCardService()
        service.setActiveUser("alice")
        let oldCard = DecisionCard(id: "old-private-card", recipientUserID: "alice", senderUserID: "bob",
                                   type: .approval, title: "Old organization", summary: "", context: "",
                                   status: .pending, priority: .high, createdAt: .now)
        service.applySnapshot(["alice": [oldCard]])
        let github = DelayedGitHubSync()
        let started = expectation(description: "GitHub request is in flight")
        github.didStart = { started.fulfill() }
        let operation = Task {
            try await service.resolve(cardID: oldCard.id, action: .createIssue,
                                      actorUserID: "alice", githubService: github)
        }
        await fulfillment(of: [started], timeout: 10)
        service.reset()
        service.setActiveUser("charlie")
        github.continuation?.resume(returning: (number: 42, url: "https://github.com/acme/old/issues/42"))
        do {
            _ = try await operation.value
            XCTFail("The old session's approval should be cancelled")
        } catch is CancellationError {
            // Expected: finishing an old request cannot write into this session.
        }
        XCTAssertTrue(service.cards(for: "alice").isEmpty)
        XCTAssertTrue(service.cards(for: "bob").isEmpty)
        XCTAssertEqual(service.pendingCount, 0)
    }

    @MainActor
    func testDelegationFinishingAfterRepositorySwitchCannotCreateFollowUpCards() async throws {
        let service = DecisionCardService()
        service.setActiveUser("alice")
        let oldCard = DecisionCard(id: "old-delegation", recipientUserID: "alice", senderUserID: "bob",
                                   type: .approval, title: "Old team", summary: "", context: "",
                                   status: .pending, priority: .high, createdAt: .now)
        service.applySnapshot(["alice": [oldCard]])
        let github = DelayedGitHubSync()
        let started = expectation(description: "Delegation sync is in flight")
        github.didStart = { started.fulfill() }
        let operation = Task {
            try await service.delegate(cardID: oldCard.id, to: "dana", actorUserID: "alice",
                                       organization: OrganizationGraph(nodes: [], edges: []), githubService: github)
        }
        await fulfillment(of: [started], timeout: 10)
        service.reset()
        service.setActiveUser("alice")
        github.continuation?.resume(returning: (number: 43, url: "https://github.com/acme/old/issues/43"))
        do {
            _ = try await operation.value
            XCTFail("The old organization's delegation should be cancelled")
        } catch is CancellationError { }
        XCTAssertTrue(service.cards(for: "dana").isEmpty)
        XCTAssertTrue(service.cards(for: "bob").isEmpty)
    }
}
