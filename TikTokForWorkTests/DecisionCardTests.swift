import XCTest
@testable import TikTokForWork

/// A decision nobody makes is the failure this product exists to replace, and it
/// is silent by construction — the card looks identical on day six and day one.
/// The waiting count is what breaks that silence, so its edges are pinned here.
///
/// No actor annotation: `DecisionCard` is a plain value type and none of this
/// touches shared state.
final class DecisionCardTests: XCTestCase {
    private func card(
        daysAgo: Int,
        status: CardStatus = .pending,
        type: CardType = .approval
    ) -> DecisionCard {
        DecisionCard(
            id: UUID().uuidString,
            recipientUserID: "alice",
            senderUserID: "bob",
            type: type,
            title: "Approve the budget",
            summary: "Q3 marketing",
            context: "",
            status: status,
            priority: .high,
            createdAt: Calendar.current.date(byAdding: .day, value: -daysAgo, to: .now)!
        )
    }

    func testTodaysCardWearsNoWarning() {
        // One day is not late. A card that arrived this morning showing
        // "waiting" would make the signal meaningless by the end of the week.
        XCTAssertNil(card(daysAgo: 0).waitingDays)
        XCTAssertNil(card(daysAgo: 1).waitingDays)
    }

    func testTheCountStartsAtTwoDays() {
        XCTAssertEqual(card(daysAgo: 2).waitingDays, 2)
        XCTAssertEqual(card(daysAgo: 9).waitingDays, 9)
    }

    func testADecidedCardIsNotWaiting() {
        // It is finished. Reporting how long it took to decide is a different
        // question, asked somewhere else.
        for status in [CardStatus.approved, .rejected, .delegated, .completed, .revised] {
            XCTAssertNil(card(daysAgo: 30, status: status).waitingDays, "\(status)")
        }
    }

    func testStaleIsWhenTheDelayBecomesTheStory() {
        XCTAssertFalse(card(daysAgo: 4).isStale)
        XCTAssertTrue(card(daysAgo: 5).isStale)
        XCTAssertFalse(card(daysAgo: 30, status: .approved).isStale)
    }

    func testOnlyDeclinedCardsCanBeDeleted() {
        // Deleting a pending card would silently drop work someone is waiting
        // on; deleting an approved one would erase a decision.
        XCTAssertTrue(card(daysAgo: 0, status: .rejected).canDelete)
        XCTAssertFalse(card(daysAgo: 0, status: .pending).canDelete)
        XCTAssertFalse(card(daysAgo: 0, status: .approved).canDelete)
    }

    func testAnUpdateIsNotADecision() {
        // "Grace approved your budget" used to arrive pending, wearing the whole
        // decision row: it could be approved, which told Grace, who could
        // approve that. Two people could approve each other's approvals until
        // one of them stopped.
        let update = card(daysAgo: 0, type: .notification)
        XCTAssertTrue(update.isPending)
        XCTAssertFalse(update.isDecision)
        XCTAssertFalse(update.needsDecision)

        let decision = card(daysAgo: 0, type: .approval)
        XCTAssertTrue(decision.isDecision)
        XCTAssertTrue(decision.needsDecision)
    }

    func testAnUpdateNeverWearsAWaitingChip() {
        // Nobody is waiting on you to read something, so counting the days is
        // an accusation the card cannot back up.
        XCTAssertNil(card(daysAgo: 9, type: .notification).waitingDays)
        XCTAssertFalse(card(daysAgo: 30, type: .notification).isStale)
        XCTAssertEqual(card(daysAgo: 9, type: .approval).waitingDays, 9)
    }

    func testAReadUpdateCanBeClearedAway() {
        // An update you have read is finished with, and leaving it in the feed
        // forever is how a feed stops being a list of what is left.
        XCTAssertTrue(card(daysAgo: 0, status: .completed, type: .notification).canDelete)
        // ...but not before it is read, and never a decision someone made.
        XCTAssertFalse(card(daysAgo: 0, status: .pending, type: .notification).canDelete)
        XCTAssertFalse(card(daysAgo: 0, status: .approved, type: .approval).canDelete)
    }

    func testAGitHubLinkIsOnlyShownForTheRepositoryItBelongsTo() {
        var linked = card(daysAgo: 0, status: .approved)
        linked.githubIssueNumber = 12
        linked.githubIssueURL = "https://github.com/acme/app/issues/12"
        linked.githubRepository = "acme/app"

        XCTAssertTrue(linked.showsGitHubLink(for: "acme/app"))
        // After switching repositories the issue is still real, but it is not
        // in the repository on screen — offering it as "this card's issue"
        // would send someone to a stranger's tracker.
        XCTAssertFalse(linked.showsGitHubLink(for: "other/repo"))
        XCTAssertFalse(linked.showsGitHubLink(for: ""))
    }

    // The relay requires two fields on a card: an id and a recipient. Everything
    // else it accepts as absent — a connector-ingested item with no summary, a
    // card from the reference web client with no explicit status, a value in an
    // enum this build has never heard of. Each of those used to make the whole
    // card fail to decode, and a card that fails to decode is a decision that
    // never appears on anyone's phone.
    func testACardMissingEverythingOptionalStillDecodes() throws {
        let json = Data(#"{"id":"c-1","recipientUserID":"bob"}"#.utf8)
        let card = try JSONDecoder().decode(DecisionCard.self, from: json)

        XCTAssertEqual(card.id, "c-1")
        XCTAssertEqual(card.recipientUserID, "bob")
        XCTAssertEqual(card.summary, "")
        XCTAssertEqual(card.status, .pending)
        XCTAssertEqual(card.priority, .medium)
        XCTAssertEqual(card.type, .task)
    }

    func testAnUnknownStatusIsShownAsTheNearestThingRatherThanDroppingTheCard() throws {
        let json = Data(#"{"id":"c-2","recipientUserID":"bob","status":"escalated","priority":"critical","type":"poll"}"#.utf8)
        let card = try JSONDecoder().decode(DecisionCard.self, from: json)

        XCTAssertEqual(card.id, "c-2")
        XCTAssertEqual(card.status, .pending)
        XCTAssertEqual(card.priority, .medium)
        XCTAssertEqual(card.type, .task)
    }

    func testACardWithNoIdIsStillRefused() {
        let json = Data(#"{"recipientUserID":"bob","title":"Ship it"}"#.utf8)
        // Not a card. The relay will not store one either.
        XCTAssertThrowsError(try JSONDecoder().decode(DecisionCard.self, from: json))
    }
}
