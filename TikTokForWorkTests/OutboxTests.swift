import XCTest
@testable import TikTokForWork

final class OutboxTests: XCTestCase {
    @MainActor
    private func makeOutbox() -> Outbox {
        let outbox = Outbox(filename: "outbox-test-\(UUID().uuidString).json")
        addTeardownBlock { @MainActor in outbox.clear() }
        return outbox
    }

    private func card(_ id: String) -> DecisionCard {
        DecisionCard(id: id, recipientUserID: "bob", senderUserID: "alice",
                     type: .approval, title: "Ship it", summary: "Ship the release",
                     context: "", status: .pending, priority: .high,
                     createdAt: Date(timeIntervalSince1970: 1_760_000_000))
    }

    @MainActor
    func testQueuedEventsAreSentInOrder() async throws {
        let outbox = makeOutbox()
        outbox.append(.cardCreated(card("c-1")))
        outbox.append(.cardUpdated(card("c-2")))
        outbox.append(.rollback(cardID: "c-2"))
        var delivered: [String] = []
        try await outbox.flush { delivered.append($0.envelope["type"] as! String) }
        XCTAssertEqual(delivered, ["card_created", "card_updated", "rollback"])
        XCTAssertEqual(outbox.count, 0)
    }

    @MainActor
    func testAFailedSendPreservesEveryUnsentEventAcrossRelaunch() async {
        let filename = "outbox-persist-\(UUID().uuidString).json"
        let outbox = Outbox(filename: filename)
        addTeardownBlock { @MainActor in Outbox(filename: filename).clear() }
        outbox.append(.cardCreated(card("c-1")))
        outbox.append(.cardUpdated(card("c-2")))
        outbox.append(.rollback(cardID: "c-2"))
        var attempts = 0
        do {
            try await outbox.flush { _ in
                attempts += 1
                if attempts == 2 { throw URLError(.networkConnectionLost) }
            }
            XCTFail("The transport error must stop this flush")
        } catch { }
        let reopened = Outbox(filename: filename)
        XCTAssertEqual(reopened.events.compactMap { $0.envelope["type"] as? String },
                       ["card_updated", "rollback"])
    }

    @MainActor
    func testAnInFlightSendStaysOnDiskUntilItSucceeds() async throws {
        let filename = "outbox-inflight-\(UUID().uuidString).json"
        let outbox = Outbox(filename: filename)
        addTeardownBlock { @MainActor in Outbox(filename: filename).clear() }
        outbox.append(.cardCreated(card("c-1")))
        try await outbox.flush { _ in
            // If iOS terminates us inside the transport await, relaunch must
            // still find the item. Draining before send broke this guarantee.
            XCTAssertEqual(Outbox(filename: filename).count, 1)
        }
        XCTAssertEqual(Outbox(filename: filename).count, 0)
    }

    @MainActor
    func testNewEventsCannotOvertakeAnInFlightDecision() async throws {
        let outbox = makeOutbox()
        outbox.append(.cardCreated(card("c-1")))
        var delivered: [String] = []
        try await outbox.flush { event in
            delivered.append(event.envelope["type"] as! String)
            if delivered.count == 1 {
                outbox.append(.rollback(cardID: "c-1"))
                // A second publisher may flush while the first awaits network.
                try await outbox.flush { _ in XCTFail("Concurrent flush reordered work") }
            }
        }
        XCTAssertEqual(delivered, ["card_created", "rollback"])
    }

    @MainActor
    func testOfflineWorkIsNotSilentlyDiscardedAfterTwoHundredEvents() {
        let outbox = makeOutbox()
        for index in 0..<250 { outbox.append(.cardUpdated(card("c-\(index)"))) }
        XCTAssertEqual(outbox.count, 250)
    }

    @MainActor
    func testSessionCredentialsAreRejectedFromTheQueue() {
        let outbox = makeOutbox()
        outbox.append(.join(userId: "alice", orgId: "acme/app", sessionToken: "secret"))
        outbox.append(.raw(["type": "join", "payload": ["sessionToken": "secret"]]))
        XCTAssertEqual(outbox.count, 0)
    }

    @MainActor
    func testAccountOrganizationAndBackendEachIsolatePendingWork() {
        let base = Outbox.filename(relayURL: "wss://relay.example", userID: "alice", orgID: "acme/app")
        let alternatives = [
            Outbox.filename(relayURL: "wss://relay.example", userID: "bob", orgID: "acme/app"),
            Outbox.filename(relayURL: "wss://relay.example", userID: "alice", orgID: "acme/other"),
            Outbox.filename(relayURL: "ws://localhost", userID: "alice", orgID: "acme/app")
        ]
        let original = Outbox(filename: base)
        original.clear()
        addTeardownBlock { @MainActor in original.clear() }
        original.append(.cardCreated(card("private-card")))
        for filename in alternatives { XCTAssertEqual(Outbox(filename: filename).count, 0) }
        XCTAssertEqual(Outbox(filename: base).count, 1)
    }

    @MainActor
    func testSigningOutClearsAllOfThatAccountsOrganizations() {
        let relay = "wss://test-\(UUID().uuidString).example"
        let first = Outbox(filename: Outbox.filename(relayURL: relay, userID: "alice", orgID: "acme/app"))
        let second = Outbox(filename: Outbox.filename(relayURL: relay, userID: "alice", orgID: "acme/other"))
        let other = Outbox(filename: Outbox.filename(relayURL: relay, userID: "bob", orgID: "acme/app"))
        addTeardownBlock { @MainActor in Outbox.clearAll(relayURL: relay, userID: "bob") }
        for queue in [first, second, other] { queue.append(.cardCreated(card("c-1"))) }
        Outbox.clearAll(relayURL: relay, userID: "alice")
        for org in ["acme/app", "acme/other"] {
            XCTAssertEqual(Outbox(filename: Outbox.filename(relayURL: relay, userID: "alice", orgID: org)).count, 0)
        }
        XCTAssertEqual(Outbox(filename: Outbox.filename(relayURL: relay, userID: "bob", orgID: "acme/app")).count, 1)
    }
}
