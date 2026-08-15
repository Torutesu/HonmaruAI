import XCTest
@testable import TikTokForWork

/// The outbox exists because of the worst failure this product had: a decision
/// made with no network vanished, silently, while showing success. These tests
/// are the record that it cannot happen again.
@MainActor
final class OutboxTests: XCTestCase {
    private var outbox: Outbox!
    private var filename: String!

    override func setUp() async throws {
        // A file per test: the queue is on disk on purpose, so sharing one
        // between tests would make them depend on order.
        filename = "outbox-test-\(UUID().uuidString).json"
        outbox = Outbox(filename: filename)
    }

    override func tearDown() async throws {
        outbox.clear()
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
            createdAt: .now
        )
    }

    func testQueuedEventsComeBackInOrder() {
        outbox.append(.cardCreated(card("c-1")))
        outbox.append(.cardUpdated(card("c-2")))
        outbox.append(.rollback(cardID: "c-2"))

        let drained = outbox.drain()
        XCTAssertEqual(drained.count, 3)
        // A decision followed by a rollback is not the same story told backwards.
        XCTAssertEqual(drained.map { $0.envelope["type"] as? String },
                       ["card_created", "card_updated", "rollback"])
        XCTAssertEqual(outbox.count, 0)
    }

    func testAnUndeliverableEventGoesBackToTheFront() {
        outbox.append(.cardCreated(card("c-1")))
        var drained = outbox.drain()
        let first = drained.removeFirst()

        outbox.prepend(first)
        XCTAssertEqual(outbox.count, 1)
        XCTAssertEqual(outbox.drain().first?.envelope["type"] as? String, "card_created")
    }

    func testTheQueueSurvivesTheProcess() {
        outbox.append(.cardUpdated(card("c-survives")))

        // The failure the outbox exists for is "no network", and the next thing
        // that usually happens is the app being killed.
        let reopened = Outbox(filename: filename)
        XCTAssertEqual(reopened.count, 1)

        let payload = reopened.drain().first?.envelope["payload"] as? [String: Any]
        let card = payload?["card"] as? [String: Any]
        XCTAssertEqual(card?["id"] as? String, "c-survives")
    }

    func testTheQueueIsBounded() {
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
}
