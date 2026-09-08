import XCTest
@testable import TikTokForWork

@MainActor
private final class ReceiptGitHubSpy: DecisionGitHubSyncing {
    let isConnected = true
    let linkedRepository = "acme/app"
    var calls = 0
    func syncDecision(_ card: DecisionCard) async throws -> (number: Int, url: String) { calls += 1; return (88, "https://github.com/acme/app/issues/88") }
    func issueState(number: Int) async throws -> String { calls += 1; return "open" }
}

final class PendingDeliveryTests: XCTestCase {
    private func pendingCard() -> DecisionCard {
        DecisionCard(id: "pending-c", recipientUserID: "alice", senderUserID: "bob", type: .approval, title: "Release review", summary: "Please review", context: "Original context", status: .pending, priority: .high, createdAt: .now)
    }

    @MainActor
    func testStaleSnapshotAndUnrelatedEnrichmentCannotConfirmADecision() {
        CardCache.clear()
        addTeardownBlock { @MainActor in CardCache.clear() }
        let original = pendingCard()
        var approved = original
        approved.status = .approved
        approved.decision = Decision(action: "approve", optionId: nil, note: nil, replyText: nil, actorUserID: "alice", decidedAt: .now)
        let expected = PendingCardDelivery(card: approved, operation: .decision)
        CardCache.save(orgID: "acme/app", cardsByUser: ["alice": [approved]], awaitingDeliveryIDs: [approved.id], pendingDeliveries: [approved.id: expected])
        let service = DecisionCardService()
        let socket = WebSocketService()
        service.attach(webSocketService: socket)
        service.setActiveUser("alice")
        service.adoptOrganization("acme/app")
        socket.onEvent?(.snapshot(cardsByUser: ["alice": [original]]))
        XCTAssertTrue(service.awaitingDeliveryIDs.contains(original.id))
        var enriched = original
        enriched.context = "Another enrichment"
        socket.onEvent?(.cardUpdated(card: enriched))
        XCTAssertTrue(service.awaitingDeliveryIDs.contains(original.id))
        socket.onEvent?(.cardUpdated(card: approved))
        XCTAssertFalse(service.awaitingDeliveryIDs.contains(original.id))
    }

    func testCreateConfirmationRequiresTheExpectedContent() {
        let original = pendingCard()
        let expected = PendingCardDelivery(card: original, operation: .create)
        var different = original
        different.summary = "Different content"
        XCTAssertFalse(expected.matches(different))
        XCTAssertTrue(expected.matches(original))
    }

    @MainActor
    func testAcknowledgingANotificationDoesNotCloseItsLinkedIssueOrCreateAnotherReceipt() async throws {
        let service = DecisionCardService()
        service.setActiveUser("alice")
        var receipt = pendingCard()
        receipt.type = .notification
        receipt.sourceDetail = "decision-result"
        receipt.githubIssueNumber = 88
        receipt.githubIssueURL = "https://github.com/acme/app/issues/88"
        receipt.githubRepository = "acme/app"
        service.applySnapshot(["alice": [receipt]])
        let github = ReceiptGitHubSpy()
        let result = try await service.resolve(cardID: receipt.id, action: .acknowledge, actorUserID: "alice", githubService: github)
        XCTAssertEqual(result.status, .completed)
        XCTAssertEqual(github.calls, 0)
        XCTAssertTrue(service.cards(for: "bob").isEmpty)
        await service.syncGitHubStatus(githubService: github)
        XCTAssertEqual(github.calls, 0)
    }
}
