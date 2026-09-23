import XCTest
@testable import TikTokForWork

@MainActor
private final class ForbiddenDemoGitHub: DecisionGitHubSyncing {
    let isConnected = true
    let linkedRepository = "real/private"
    var calls = 0
    func syncDecision(_ card: DecisionCard) async throws -> (number: Int, url: String) {
        calls += 1
        XCTFail("Demo actions must never call GitHub")
        return (1, "https://github.com/real/private/issues/1")
    }
    func issueState(number: Int) async throws -> String {
        calls += 1
        XCTFail("Demo synchronization must never call GitHub")
        return "open"
    }
}

final class DemoWorkspaceTests: XCTestCase {
    @MainActor
    func testDemoHasDistinctInboxSentAndCompletedRequests() {
        let service = makeDemo()
        let all = service.allCards(for: DemoWorkspace.userID)
        XCTAssertEqual(all.count, 5)
        XCTAssertEqual(all.filter { $0.recipientUserID == DemoWorkspace.userID && $0.isPending }.count, 3)
        XCTAssertEqual(all.filter { $0.senderUserID == DemoWorkspace.userID }.count, 1)
        XCTAssertEqual(all.filter { $0.recipientUserID == DemoWorkspace.userID && !$0.isPending }.count, 1)
    }

    @MainActor
    func testDemoApprovalAndUndoAreLocalAndDoNotUndoAnUnrelatedDecision() async throws {
        let service = makeDemo()
        let github = ForbiddenDemoGitHub()
        let approved = try await service.resolve(cardID: "demo-launch", action: .createIssue, actorUserID: DemoWorkspace.userID, githubService: github)
        XCTAssertEqual(approved.status, .approved)
        XCTAssertNil(approved.githubIssueNumber)
        _ = try await service.resolve(cardID: "demo-checklist", action: .acknowledge, actorUserID: DemoWorkspace.userID, githubService: github)
        try await service.undo(cardID: "demo-launch", actorUserID: DemoWorkspace.userID)
        XCTAssertEqual(service.card(id: "demo-launch")?.status, .pending)
        XCTAssertEqual(service.card(id: "demo-checklist")?.status, .completed)
        XCTAssertTrue(service.awaitingDeliveryIDs.isEmpty)
        await service.syncGitHubStatus(githubService: github)
        XCTAssertEqual(github.calls, 0)
    }

    @MainActor
    func testReplyRequiresTextAndRecordsCompletedReply() async throws {
        let service = makeDemo()
        let github = ForbiddenDemoGitHub()
        do {
            _ = try await service.resolve(cardID: "demo-design", action: .reply, actorUserID: DemoWorkspace.userID, replyText: "  ", githubService: github)
            XCTFail("An empty reply must remain pending")
        } catch CardServiceError.missingReply { }
        XCTAssertEqual(service.card(id: "demo-design")?.status, .pending)
        let replied = try await service.resolve(cardID: "demo-design", action: .reply, actorUserID: DemoWorkspace.userID, replyText: "  Let's use option A.  ", githubService: github)
        XCTAssertEqual(replied.status, .completed)
        XCTAssertEqual(replied.decision?.action, "reply")
        XCTAssertEqual(replied.decision?.replyText, "Let's use option A.")
        XCTAssertEqual(github.calls, 0)
    }

    @MainActor
    func testDemoCannotContaminateAnAdoptedRealWorkspace() {
        let service = makeDemo()
        service.reset()
        service.setActiveUser("real-user")
        service.adoptOrganization("demo-regression-empty-org")
        XCTAssertFalse(service.isDemo)
        XCTAssertTrue(service.allCards(for: DemoWorkspace.userID).isEmpty)
        XCTAssertEqual(service.pendingCount, 0)
    }

    @MainActor
    func testCreatingADemoRequestUsesOnlyAnExistingExplicitMember() async throws {
        let service = makeDemo()
        let sender = User(id: DemoWorkspace.userID, name: "You", role: "Product", teamID: DemoWorkspace.id, githubUsername: nil)
        let draft = OfflineRouter.draft(text: "Please review the design", sender: sender, priority: .high, recipientUserID: "demo-mika")
        let card = try await service.processRouting(draft.asRouting(), sourceText: draft.sourceText, from: sender)
        XCTAssertEqual(card.recipientUserID, "demo-mika")
        XCTAssertEqual(service.allCards(for: DemoWorkspace.userID).filter { $0.senderUserID == DemoWorkspace.userID }.count, 2)
        XCTAssertTrue(service.awaitingDeliveryIDs.isEmpty)
        let unknown = OfflineRouter.draft(text: "Design review", sender: sender, priority: .medium, recipientUserID: "invented-member")
        do {
            _ = try await service.processRouting(unknown.asRouting(), sourceText: unknown.sourceText, from: sender)
            XCTFail("The demo must not invent recipients")
        } catch CardServiceError.cardNotFound { }
    }

    @MainActor
    func testOfflineRealWorkspaceCannotReportSendSuccess() async throws {
        let service = DecisionCardService()
        let sender = User(id: "alice", name: "Alice", role: "Member", teamID: "acme/team", githubUsername: "alice")
        service.setActiveUser(sender.id)
        let draft = OfflineRouter.draft(text: "Review client design", sender: sender, priority: .high)
        XCTAssertEqual(draft.recipientUserID, sender.id)
        do {
            _ = try await service.processRouting(draft.asRouting(), sourceText: draft.sourceText, from: sender)
            XCTFail("A missing joined relay must keep this as a draft")
        } catch CardServiceError.notConnected { }
        XCTAssertTrue(service.allCards(for: sender.id).isEmpty)
    }

    @MainActor
    private func makeDemo() -> DecisionCardService {
        let service = DecisionCardService()
        service.attach(webSocketService: WebSocketService())
        service.activateDemo(cardsByUser: DemoWorkspace.cards(), userID: DemoWorkspace.userID)
        return service
    }
}
