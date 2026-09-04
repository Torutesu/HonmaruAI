import XCTest
@testable import TikTokForWork

/// Drafting with no relay.
///
/// This exists so a dead network costs you quality rather than the ability to
/// file anything at all — which matters most in exactly the situation where you
/// cannot fix it, standing in front of someone with a phone in your hand.
final class OfflineRouterTests: XCTestCase {
    private let sender = User(
        id: "ada", name: "Ada", role: "Engineering",
        teamID: "team-app", githubUsername: "ada"
    )

    private func draft(_ text: String, priority: CardPriority = .medium) -> InstructionDraft {
        OfflineRouter.draft(text: text, sender: sender, priority: priority)
    }

    // It used to guess. Two keyword tables sent anything mentioning a logo to
    // "user-yui" and anything mentioning a delivery to "user-tanaka" —
    // colleagues who existed in a demo and in no real organization. The relay
    // stored those cards, nobody could ever decide them, and the sender was
    // told they had been routed.
    func testTheCardIsYoursUntilYouSayOtherwise() {
        XCTAssertEqual(draft("Ask Yui to approve the new logo").recipientUserID, sender.id)
        XCTAssertEqual(draft("配送の件、田中さんにお願い").recipientUserID, sender.id)
    }

    func testTheReasonSaysWhatHappenedRatherThanClaimingARoute() {
        let reason = draft("Approve the budget").routingReason
        XCTAssertFalse(reason.isEmpty)
        // Not "routed to X" — nothing was routed anywhere.
        XCTAssertFalse(reason.lowercased().contains("routed to"))
    }

    func testTheTypeIsReadFromTheWordsInEitherLanguage() {
        XCTAssertEqual(draft("Approve the Q4 budget").cardType, .approval)
        XCTAssertEqual(draft("この見積もりの承認をお願いします").cardType, .approval)
        XCTAssertEqual(draft("Delegate the pricing page to someone").cardType, .delegation)
        XCTAssertEqual(draft("Fix the failing build").cardType, .task)
    }

    // Paraphrasing without a model only invents detail, so the instruction is
    // shown as written — and a title has to fit on a card.
    func testALongInstructionIsTruncatedForTheTitleAndKeptWholeInTheSummary() {
        let long = "Please approve the updated vendor contract before the end of the quarter"
        let card = draft(long)
        XCTAssertLessThanOrEqual(card.title.count, 29)
        XCTAssertTrue(card.title.hasSuffix("…"))
        XCTAssertEqual(card.summary, long)
    }

    func testAShortInstructionIsNotTruncated() {
        let card = draft("Approve the budget")
        XCTAssertEqual(card.title, "Approve the budget")
        XCTAssertFalse(card.title.hasSuffix("…"))
    }

    func testThePriorityIsTheOneTheSenderChose() {
        XCTAssertEqual(draft("Approve the budget", priority: .urgent).priority, .urgent)
        XCTAssertEqual(draft("Approve the budget", priority: .low).priority, .low)
    }

    func testEveryDraftGetsItsOwnID() {
        XCTAssertNotEqual(draft("Approve it").id, draft("Approve it").id)
    }
}
