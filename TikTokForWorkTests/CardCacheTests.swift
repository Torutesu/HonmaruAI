import XCTest
@testable import TikTokForWork

/// The cache is what stands between a cold launch and a blank feed. Its one
/// non-obvious rule — a cache belongs to exactly one organization — is the one
/// that would otherwise show a user another team's decisions after a repository
/// switch.
///
/// Isolation per method, for the reason given in OutboxTests.
final class CardCacheTests: XCTestCase {
    @MainActor
    private func clean() {
        CardCache.clear()
        addTeardownBlock { @MainActor in CardCache.clear() }
    }

    private func card(_ id: String) -> DecisionCard {
        DecisionCard(
            id: id,
            recipientUserID: "alice",
            senderUserID: "bob",
            type: .approval,
            title: "Approve the budget",
            summary: "Q3 marketing spend",
            context: "Deadline: Friday",
            status: .pending,
            priority: .high,
            createdAt: Date(timeIntervalSince1970: 1_760_000_000)
        )
    }

    @MainActor
    func testARoundTripKeepsTheFeed() {
        clean()
        CardCache.save(orgID: "acme/app", cardsByUser: ["alice": [card("c-1"), card("c-2")]])

        let loaded = CardCache.load(orgID: "acme/app")
        XCTAssertEqual(loaded["alice"]?.count, 2)
        XCTAssertEqual(loaded["alice"]?.first?.title, "Approve the budget")
        // Dates round-trip through ISO 8601 on both sides. A mismatch here shows
        // up as a feed sorted into nonsense, not as an error.
        XCTAssertEqual(loaded["alice"]?.first?.createdAt, Date(timeIntervalSince1970: 1_760_000_000))
    }

    @MainActor
    func testAnotherOrganizationsCacheIsNotOurs() {
        clean()
        CardCache.save(orgID: "acme/app", cardsByUser: ["alice": [card("c-1")]])

        // Switching repositories switches organizations. Showing the previous
        // one's decisions would be showing another team's work.
        XCTAssertTrue(CardCache.load(orgID: "other/repo").isEmpty)
    }

    @MainActor
    func testNoCacheIsAnEmptyFeed() {
        clean()
        XCTAssertTrue(CardCache.load(orgID: "acme/app").isEmpty)
    }

    @MainActor
    func testClearingLeavesNothingBehind() {
        clean()
        CardCache.save(orgID: "acme/app", cardsByUser: ["alice": [card("c-1")]])
        CardCache.clear()
        // Sign-out clears this. A cache that survived would show the next person
        // on the device the previous account's decisions.
        XCTAssertTrue(CardCache.load(orgID: "acme/app").isEmpty)
    }
}
