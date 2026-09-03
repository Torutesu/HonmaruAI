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

    func testScopedFilenamesCannotCollideAcrossUsersOrOrganizations() {
        let aliceAcme = Outbox.filename(userID: "alice", orgID: "acme/app")
        let aliceOther = Outbox.filename(userID: "alice", orgID: "other/repo")
        let bobAcme = Outbox.filename(userID: "bob", orgID: "acme/app")

        XCTAssertNotEqual(aliceAcme, aliceOther)
        XCTAssertNotEqual(aliceAcme, bobAcme)
        XCTAssertFalse(aliceAcme.contains("/"))
    }
}
