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
        status: CardStatus = .pending
    ) -> DecisionCard {
        DecisionCard(
            id: UUID().uuidString,
            recipientUserID: "alice",
            senderUserID: "bob",
            type: .approval,
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

    func testTheReaderSeesTheRelaysTranslationAndTheOriginalIsKept() {
        let previous = UserDefaults.standard.string(forKey: "appLanguage")
        defer { UserDefaults.standard.set(previous, forKey: "appLanguage") }
        UserDefaults.standard.set("ja", forKey: "appLanguage")

        var translated = card(daysAgo: 0)
        translated.context = "deadline: Friday"
        translated.localized = ["ja": CardTranslation(title: "予算の承認", summary: "第3四半期のマーケティング", context: "期限: 金曜")]
        XCTAssertEqual(translated.displayTitle, "予算の承認")
        XCTAssertEqual(translated.displaySummary, "第3四半期のマーケティング")
        XCTAssertEqual(translated.displayContext, "期限: 金曜")
        // The sender's words are what gets republished on a decision.
        XCTAssertEqual(translated.title, "Approve the budget")

        // A region is not a language; another language's translation is not yours.
        XCTAssertEqual(translated.translation(for: "ja-JP")?.title, "予算の承認")
        XCTAssertNil(translated.translation(for: "vi"))
        UserDefaults.standard.set("en", forKey: "appLanguage")
        XCTAssertEqual(translated.displayTitle, "Approve the budget")
    }

    func testATranslationArrivesFromTheRelayUnderLocalized() throws {
        let json = """
        {"id":"c-1","recipientUserID":"alice","senderUserID":"bob","type":"approval","title":"Approve the budget",
         "summary":"Q3","context":"","status":"pending","priority":"high","createdAt":"2026-09-24T00:00:00Z",
         "localized":{"vi":{"title":"Phê duyệt ngân sách","summary":"Quý 3"}}}
        """
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let decoded = try decoder.decode(DecisionCard.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.translation(for: "vi")?.title, "Phê duyệt ngân sách")
        XCTAssertNil(decoded.translation(for: "vi")?.context)
    }
}
