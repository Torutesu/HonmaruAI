import XCTest
@testable import TikTokForWork

/// The cache is what stands between a cold launch and a blank feed. Its one
/// non-obvious rule — a cache belongs to exactly one organization — is the one
/// that would otherwise show a user another team's decisions after a repository
/// switch.
@MainActor
final class CardCacheTests: XCTestCase {
    override func setUp() async throws {
        CardCache.clear()
    }

    override func tearDown() async throws {
        CardCache.clear()
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

    func testARoundTripKeepsTheFeed() {
        CardCache.save(orgID: "acme/app", cardsByUser: ["alice": [card("c-1"), card("c-2")]])

        let loaded = CardCache.load(orgID: "acme/app")
        XCTAssertEqual(loaded["alice"]?.count, 2)
        XCTAssertEqual(loaded["alice"]?.first?.title, "Approve the budget")
        XCTAssertEqual(loaded["alice"]?.first?.createdAt, Date(timeIntervalSince1970: 1_760_000_000))
    }

    func testAnotherOrganizationsCacheIsNotOurs() {
        CardCache.save(orgID: "acme/app", cardsByUser: ["alice": [card("c-1")]])

        // Switching repositories switches organizations. Showing the previous
        // one's decisions would be showing another team's work.
        XCTAssertTrue(CardCache.load(orgID: "other/repo").isEmpty)
    }

    func testNoCacheIsAnEmptyFeed() {
        XCTAssertTrue(CardCache.load(orgID: "acme/app").isEmpty)
    }
}
