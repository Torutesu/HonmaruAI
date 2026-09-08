import XCTest
@testable import TikTokForWork

final class RequestComposerTests: XCTestCase {
    @MainActor
    func testDemoPreviewAndSendPreserveEditedFieldsAndExplicitRecipient() async throws {
        let app = AppState(startServices: false)
        app.activateGuestSession()
        let composer = FeedViewModel()
        composer.bind(to: app)
        composer.sourceText = "Review the draft before Friday"
        composer.recipientID = "demo-mika"
        composer.cardType = .task
        composer.priority = .urgent
        await composer.prepare(appState: app)
        XCTAssertTrue(composer.isReviewing)
        XCTAssertEqual(composer.recipientID, "demo-mika")
        XCTAssertEqual(composer.cardType, .task)
        composer.title = "Edited launch review"
        composer.summary = "Please check the headline."
        composer.context = "The draft is ready."
        let sent = await composer.send(appState: app)
        let card = try XCTUnwrap(sent)
        XCTAssertEqual(card.title, "Edited launch review")
        XCTAssertEqual(card.summary, "Please check the headline.")
        XCTAssertEqual(card.context, "The draft is ready.")
        XCTAssertEqual(card.recipientUserID, "demo-mika")
        XCTAssertEqual(card.type, .task)
        XCTAssertEqual(card.priority, .urgent)
        XCTAssertFalse(composer.hasDraft)
        XCTAssertTrue(app.cardService.awaitingDeliveryIDs.isEmpty)
    }

    @MainActor
    func testOfflineSendRetainsEditableDraft() async {
        let app = AppState(startServices: false)
        app.currentUser = User(id: "alice", name: "Alice", role: "Member", teamID: "acme/team", githubUsername: nil)
        let composer = FeedViewModel()
        composer.bind(to: app)
        composer.sourceText = "Original text"
        composer.title = "Carefully edited title"
        composer.summary = "Carefully edited summary"
        composer.recipientID = "bob"
        composer.isReviewing = true
        let result = await composer.send(appState: app)
        XCTAssertNil(result)
        XCTAssertEqual(composer.title, "Carefully edited title")
        XCTAssertEqual(composer.summary, "Carefully edited summary")
        XCTAssertEqual(composer.recipientID, "bob")
        XCTAssertTrue(composer.isReviewing)
        XCTAssertNotNil(composer.errorMessage)
        XCTAssertFalse(composer.isSending)
    }

    @MainActor
    func testOversizeDraftStaysEditableAndDoesNotCreateACard() async {
        let app = AppState(startServices: false)
        app.activateGuestSession()
        let composer = FeedViewModel()
        composer.bind(to: app)
        composer.title = "Review launch"
        composer.summary = String(repeating: "🎉", count: 1001)
        composer.recipientID = "demo-mika"
        composer.isReviewing = true
        let result = await composer.send(appState: app)
        XCTAssertNil(result)
        XCTAssertEqual(composer.summary.utf16.count, 2002)
        XCTAssertTrue(composer.isReviewing)
        XCTAssertNotNil(composer.validationMessage)
        XCTAssertEqual(app.cardService.allCards(for: DemoWorkspace.userID).count, 5)
    }

    @MainActor
    func testAReplacementSessionCannotInheritThePreviousDraft() {
        let app = AppState(startServices: false)
        app.activateGuestSession()
        let composer = FeedViewModel()
        composer.bind(to: app)
        composer.sourceText = "A draft from the previous session"
        let previousSession = app.activeSessionID
        app.activateGuestSession()
        XCTAssertNotEqual(app.activeSessionID, previousSession)
        composer.bind(to: app)
        XCTAssertFalse(composer.hasDraft)
        XCTAssertTrue(composer.recipientID.isEmpty)
    }
}
