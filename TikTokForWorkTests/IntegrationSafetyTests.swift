import XCTest
@testable import TikTokForWork

final class IntegrationSafetyTests: XCTestCase {
    @MainActor
    func testAuthoritativeEmptySnapshotRemovesDeletedCards() {
        let service = DecisionCardService()
        service.applySnapshot(["alice": [card()]])
        XCTAssertEqual(service.cards(for: "alice").count, 1)
        service.applySnapshot([:])
        XCTAssertTrue(service.cards(for: "alice").isEmpty)
    }

    @MainActor
    func testAccountSwitchClearsThePreviousFeed() {
        let service = DecisionCardService()
        service.setActiveUser("alice")
        service.applySnapshot(["alice": [card()]])
        service.setActiveUser("bob")
        XCTAssertTrue(service.cards(for: "alice").isEmpty)
        XCTAssertEqual(service.pendingCount, 0)
    }

    @MainActor
    func testOfflineDraftDoesNotNeedAIConsent() async throws {
        let state = AppState(startServices: false)
        state.activateGuestSession()
        let model = FeedViewModel()
        model.bind(to: state.cardService, user: try XCTUnwrap(state.currentUser), githubService: state.githubService)
        let draft = await model.draftInstruction("Keep this local", priority: .medium, appState: state)
        XCTAssertEqual(draft?.sourceText, "Keep this local")
        XCTAssertEqual(draft?.recipientUserID, "guest")
        await model.sendDraft(try XCTUnwrap(draft), appState: state)
        // Guest preview must not claim a real team delivery.
        XCTAssertFalse(state.webSocketService.isConnected)
        XCTAssertNotNil(model.errorMessage)
    }

    func testMainTeamContractRetainsPrivateMemberReferences() throws {
        let member = try JSONDecoder().decode(TeamMember.self, from: Data(#"{"ref":"opaque-ref","name":"Alice","role":"member","title":null,"mine":true}"#.utf8))
        XCTAssertEqual(member.id, "opaque-ref")
        XCTAssertTrue(member.mine)
    }

    private func card() -> DecisionCard {
        DecisionCard(id: "integration-test", recipientUserID: "alice", senderUserID: "bob",
                     type: .approval, title: "Test", summary: "Summary", context: "",
                     status: .pending, priority: .medium, createdAt: .now)
    }
}
