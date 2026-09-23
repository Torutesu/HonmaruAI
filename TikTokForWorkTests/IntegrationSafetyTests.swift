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
        model.bind(to: state)
        model.sourceText = "Keep this local"
        model.recipientID = "guest"
        await model.prepare(appState: state)
        XCTAssertEqual(model.sourceText, "Keep this local")
        XCTAssertEqual(model.recipientID, "guest")
        let card = await model.send(appState: state)
        // An explicit demo is local only, never a real team delivery.
        XCTAssertFalse(state.webSocketService.isConnected)
        XCTAssertTrue(state.cardService.isDemo)
        XCTAssertNotNil(card)
        XCTAssertTrue(state.cardService.awaitingDeliveryIDs.isEmpty)
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
