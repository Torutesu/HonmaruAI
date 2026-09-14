import XCTest
@testable import TikTokForWork

/// The offline router used to send design work to `user-yui` — a demo id that
/// no real organization contains, so the relay refused the card and it sat in
/// the feed looking delivered while nobody ever saw it. Every answer it gives
/// now has to be someone the relay will actually accept: a member of the org,
/// or the sender.
final class OfflineRouterTests: XCTestCase {
    private let sender = User(id: "alice", name: "Alice", role: "Admin")
    private let org = OrganizationGraph(
        nodes: [
            OrgNode(id: "acme/web", kind: .team, label: "acme/web"),
            OrgNode(id: "alice", kind: .person, label: "Alice · Admin"),
            OrgNode(id: "yui", kind: .person, label: "Yui · Designer"),
            OrgNode(id: "kenji", kind: .person, label: "Kenji · Engineer"),
        ],
        edges: [
            OrgEdge(id: "e1", fromID: "yui", toID: "acme/web", kind: .canApprove),
        ]
    )

    func testNamedMemberGetsTheCard() {
        let draft = OfflineRouter.draft(
            text: "ask Yui to review the logo", sender: sender,
            organization: org, priority: .medium
        )
        XCTAssertEqual(draft.recipientUserID, "yui")
    }

    func testRoleWordFindsTheMemberHoldingIt() {
        let draft = OfflineRouter.draft(
            text: "design review needed on the banner", sender: sender,
            organization: org, priority: .medium
        )
        XCTAssertEqual(draft.recipientUserID, "yui")
    }

    func testNobodyNamedMeansAnApproverOrYourself() {
        let draft = OfflineRouter.draft(
            text: "needs sign-off on the invoice", sender: sender,
            organization: org, priority: .medium
        )
        // Never a demo id — the relay refuses recipients outside the org.
        XCTAssertFalse(["user-yui", "user-tanaka", "user-toru", "user-alex"].contains(draft.recipientUserID))
        XCTAssertTrue(["alice", "yui"].contains(draft.recipientUserID))
    }

    func testEmptyOrgRoutesToSelf() {
        let draft = OfflineRouter.draft(
            text: "anything", sender: sender,
            organization: OrganizationGraph(nodes: [], edges: []), priority: .medium
        )
        XCTAssertEqual(draft.recipientUserID, "alice")
    }
}

/// The relay's STATE_SNAPSHOT carries every member's context and deltas carry
/// `/context/<userId>` patches; both used to be dropped, so a context edited on
/// another device never reached this one.
final class AGUIContextTests: XCTestCase {
    private func assembler() -> AGUIEventAssembler {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return AGUIEventAssembler(decoder: decoder)
    }

    func testSnapshotEmitsContextEvents() {
        let events = assembler().handle([
            "type": "STATE_SNAPSHOT",
            "snapshot": [
                "cardsById": [:],
                "context": [
                    "alice": ["text": "I decide fast"],
                    "bob": "plain string context",
                ],
            ],
        ])
        let contexts = events.compactMap { event -> (String, String)? in
            guard case .contextReceived(let userId, let text) = event else { return nil }
            return (userId, text)
        }
        XCTAssertEqual(contexts.count, 2)
        XCTAssertTrue(contexts.contains(where: { $0.0 == "alice" && $0.1 == "I decide fast" }))
        XCTAssertTrue(contexts.contains(where: { $0.0 == "bob" && $0.1 == "plain string context" }))
    }

    func testContextDeltaEmitsAnEvent() {
        let events = assembler().handle([
            "type": "STATE_DELTA",
            "delta": [["op": "replace", "path": "/context/alice", "value": ["text": "updated"]]],
        ])
        guard case .contextReceived(let userId, let text) = events.first else {
            return XCTFail("no context event in \(events)")
        }
        XCTAssertEqual(userId, "alice")
        XCTAssertEqual(text, "updated")
    }
}
