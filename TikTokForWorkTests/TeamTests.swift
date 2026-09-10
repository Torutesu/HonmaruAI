import XCTest
@testable import TikTokForWork

/// The two halves of team work on a phone that can be checked without a
/// screen: what a person is called, and what they are waiting on other people
/// for.
final class TeamTests: XCTestCase {

    // MARK: - What a person is called

    /// An email account's id is `u:someone@company.com` on the relay and
    /// `email:someone@company.com` as the account id. Falling back to the id
    /// put a colleague's whole address on a card, in the routing line under
    /// it, and in history — everywhere `DisplayName.of` is called, which is
    /// everywhere a name appears.
    func testAnIdIsNeverShownAsAnAddress() {
        XCTAssertEqual(DisplayName.short("u:mai@company.com"), "mai")
        XCTAssertEqual(DisplayName.short("email:mai@company.com"), "mai")
        XCTAssertEqual(DisplayName.of("u:mai@company.com"), "mai")
        XCTAssertFalse(DisplayName.of("u:mai@company.com").contains("@"))
    }

    /// A GitHub login is already a name and must survive untouched.
    func testAGitHubLoginIsLeftAlone() {
        XCTAssertEqual(DisplayName.short("octocat"), "octocat")
        XCTAssertEqual(DisplayName.of("octocat"), "octocat")
    }

    /// The rule matches the web client's `displayName()` exactly, including
    /// the case neither should get wrong: an id that is nothing but a prefix.
    func testAnIdThatIsOnlyAPrefixKeepsItsOwnText() {
        XCTAssertEqual(DisplayName.short("u:"), "u:")
        XCTAssertEqual(DisplayName.short(""), "")
    }

    /// The org graph still wins when it has a label for this person.
    func testTheOrgGraphNameWinsWhenThereIsOne() {
        let graph = OrganizationGraph(
            nodes: [OrgNode(id: "u:mai@company.com", kind: .person, label: "Mai Tanaka · designer")],
            edges: []
        )
        XCTAssertEqual(DisplayName.of("u:mai@company.com", in: graph), "Mai Tanaka")
    }

    // MARK: - What you are waiting on

    private func card(_ id: String, from sender: String, to recipient: String, at seconds: TimeInterval) -> DecisionCard {
        DecisionCard(
            id: id,
            recipientUserID: recipient,
            senderUserID: sender,
            type: .approval,
            title: "Approve the budget",
            summary: "Q3 spend",
            context: "",
            status: .pending,
            priority: .high,
            createdAt: Date(timeIntervalSince1970: seconds)
        )
    }

    /// The store is keyed by recipient, because that is the question the feed
    /// asks. Nothing had ever asked the other one, so there was nowhere on a
    /// phone to see a decision of yours going unanswered — and nowhere to
    /// nudge from, which is why the SLA work shipped as a chip and no more.
    @MainActor
    func testSentListsWhatYouAskedOfOtherPeople() {
        let service = DecisionCardService()
        service.applySnapshot([
            "kenji": [card("c1", from: "me", to: "kenji", at: 1_000)],
            "aya": [card("c2", from: "me", to: "aya", at: 2_000)],
            "me": [
                card("c3", from: "kenji", to: "me", at: 3_000),
                card("c4", from: "me", to: "me", at: 4_000),
            ],
        ])

        let sent = service.sent(by: "me")
        // Newest first, and only the ones that are waiting on somebody else.
        XCTAssertEqual(sent.map(\.id), ["c2", "c1"])
        // Not what is waiting on me: that is the feed.
        XCTAssertFalse(sent.contains { $0.id == "c3" })
        // Nor one I sent to myself, which is already in my own feed.
        XCTAssertFalse(sent.contains { $0.id == "c4" })
    }

    @MainActor
    func testSentIsEmptyForSomeoneWhoHasAskedNothing() {
        let service = DecisionCardService()
        service.applySnapshot(["me": [card("c1", from: "kenji", to: "me", at: 1_000)]])
        XCTAssertTrue(service.sent(by: "me").isEmpty)
    }
}
