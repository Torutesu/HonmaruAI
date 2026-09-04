import XCTest
@testable import TikTokForWork

/// The outbox exists because of the worst failure this product had: a decision
/// made with no network vanished, silently, while showing success. These tests
/// are the record that it cannot happen again.
///
/// Isolation is per test method rather than on the class: `XCTestCase.setUp()`
/// is not main-actor isolated, and overriding it from a `@MainActor` class means
/// arguing with the compiler about actor inheritance for no benefit. Each test
/// makes its own queue instead — which it wants anyway, since the queue is on
/// disk and a shared file would make these depend on order.
final class OutboxTests: XCTestCase {
    @MainActor
    private func makeOutbox() -> Outbox {
        let outbox = Outbox(filename: "outbox-test-\(UUID().uuidString).json")
        addTeardownBlock { @MainActor in outbox.clear() }
        return outbox
    }

    private func card(_ id: String, recipient: String = "bob") -> DecisionCard {
        DecisionCard(
            id: id,
            recipientUserID: recipient,
            senderUserID: "alice",
            type: .approval,
            title: "Ship it",
            summary: "Ship the release",
            context: "",
            status: .pending,
            priority: .high,
            createdAt: Date(timeIntervalSince1970: 1_760_000_000)
        )
    }

    @MainActor
    func testQueuedEventsComeBackInOrder() {
        let outbox = makeOutbox()
        outbox.append(.cardCreated(card("c-1")))
        outbox.append(.cardUpdated(card("c-2")))
        outbox.append(.rollback(cardID: "c-2"))

        let drained = outbox.drain()
        XCTAssertEqual(drained.count, 3)
        // A decision followed by a rollback is not the same story told backwards.
        XCTAssertEqual(
            drained.map { $0.envelope["type"] as? String },
            ["card_created", "card_updated", "rollback"]
        )
        XCTAssertEqual(outbox.count, 0)
    }

    @MainActor
    func testAnUndeliverableEventGoesBackToTheFront() {
        let outbox = makeOutbox()
        outbox.append(.cardCreated(card("c-1")))
        var drained = outbox.drain()
        let first = drained.removeFirst()

        outbox.prepend(first)
        XCTAssertEqual(outbox.count, 1)
        XCTAssertEqual(outbox.drain().first?.envelope["type"] as? String, "card_created")
    }

    @MainActor
    func testTheQueueSurvivesTheProcess() {
        let filename = "outbox-persist-\(UUID().uuidString).json"
        let outbox = Outbox(filename: filename)
        addTeardownBlock { @MainActor in Outbox(filename: filename).clear() }
        outbox.append(.cardUpdated(card("c-survives")))

        // The failure the outbox exists for is "no network", and the next thing
        // that usually happens is the app being killed.
        let reopened = Outbox(filename: filename)
        XCTAssertEqual(reopened.count, 1)

        let payload = reopened.drain().first?.envelope["payload"] as? [String: Any]
        let card = payload?["card"] as? [String: Any]
        XCTAssertEqual(card?["id"] as? String, "c-survives")
    }

    @MainActor
    func testTheQueueIsBounded() {
        let outbox = makeOutbox()
        for index in 0..<250 {
            outbox.append(.cardUpdated(card("c-\(index)")))
        }
        // A week offline is a disk problem, not a delivery guarantee. The
        // newest state of a card is the one worth keeping.
        XCTAssertEqual(outbox.count, 200)

        let ids = outbox.drain().compactMap { event -> String? in
            let payload = event.envelope["payload"] as? [String: Any]
            return (payload?["card"] as? [String: Any])?["id"] as? String
        }
        XCTAssertEqual(ids.first, "c-50")
        XCTAssertEqual(ids.last, "c-249")
    }

    @MainActor
    func testASessionTokenNeverReachesTheDisk() {
        // `join` carries the session token, and it is the one message that must
        // never be queued. It cannot reach the outbox today — a failed join
        // schedules a reconnect instead — and this is the guard on that staying
        // true if the send path is ever refactored.
        let outbox = makeOutbox()
        outbox.append(.cardCreated(card("c-1")))
        let serialized = outbox.drain().map { String(describing: $0.envelope) }.joined()
        XCTAssertFalse(serialized.contains("sessionToken"))
    }

    // A join snapshot is the server's whole truth. The app used to refuse an
    // empty one so an offline decision would survive it, which meant a device
    // whose organization had cleared its cards kept showing them forever. These
    // are what makes taking the snapshot at face value safe.
    @MainActor
    func testTheQueueCanNameTheCardsTheRelayHasNotSeen() {
        let outbox = makeOutbox()
        outbox.append(.cardCreated(card("c-1")))
        outbox.append(.cardUpdated(card("c-2", recipient: "carol")))
        outbox.append(.contextUpdated(text: "not a card"))

        let unsent = outbox.unsentCards()
        XCTAssertEqual(unsent.map(\.id), ["c-1", "c-2"])
        XCTAssertEqual(unsent.last?.recipientUserID, "carol")
        // Reading the queue must not consume it: these still have to be sent.
        XCTAssertEqual(outbox.count, 3)
    }

    @MainActor
    func testADeletionThatHasNotBeenSentIsNamedToo() {
        let outbox = makeOutbox()
        outbox.append(.cardDeleted(cardID: "c-9", recipientUserID: "bob"))
        outbox.append(.cardCreated(card("c-1")))

        XCTAssertEqual(outbox.unsentDeletions(), ["c-9"])
        XCTAssertEqual(outbox.unsentCards().map(\.id), ["c-1"])
    }

    // Dates go out ISO 8601 and have to come back the same.
    @MainActor
    func testACardSurvivesTheRoundTripThroughTheQueue() throws {
        let outbox = makeOutbox()
        let original = card("c-round")
        outbox.append(.cardCreated(original))

        let back = try XCTUnwrap(outbox.unsentCards().first)
        XCTAssertEqual(back.id, original.id)
        XCTAssertEqual(back.title, original.title)
        XCTAssertEqual(back.priority, original.priority)
        XCTAssertEqual(
            back.createdAt.timeIntervalSince1970,
            original.createdAt.timeIntervalSince1970,
            accuracy: 1
        )
    }
}
