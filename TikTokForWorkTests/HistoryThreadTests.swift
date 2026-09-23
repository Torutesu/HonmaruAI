import XCTest
@testable import TikTokForWork

/// History is one row per card. These pin how the relay's events become
/// those rows: grouped, newest first, the card recovered from the event
/// that recorded it whole, the feed's copy preferred when it has one.
final class HistoryThreadTests: XCTestCase {
    private func event(_ id: String, card: String, type: String, at: String, action: String? = nil,
                       actor: String? = nil, note: String? = nil, snapshot: String) -> String {
        let quoted: (String?) -> String = { value in value.map { "\"" + $0 + "\"" } ?? "null" }
        let actionJSON = quoted(action)
        let actorJSON = quoted(actor)
        let noteJSON = quoted(note)
        return """
        {"id":"\(id)","cardId":"\(card)","type":"\(type)","action":\(actionJSON),
         "actorUserId":\(actorJSON),"note":\(noteJSON),
         "createdAt":"\(at)","snapshot":\(snapshot)}
        """
    }

    private func wholeCard(_ id: String, title: String, status: String, decided: Bool) -> String {
        let decision = decided
            ? #","decision":{"action":"decline","actorUserID":"toru","decidedAt":"2026-09-11T09:00:00.000Z","replyText":"Not until the lease is settled"}"#
            : ""
        return """
        {"id":"\(id)","recipientUserID":"toru","senderUserID":"mika","type":"approval","title":"\(title)",
         "summary":"Mika wants the Ethiopian supplier.","context":"","status":"\(status)","priority":"high",
         "createdAt":"2026-09-10T08:00:00Z","sourceApp":"Gmail"\(decision)}
        """
    }

    private func decode(_ events: [String]) throws -> [CardEvent] {
        let json = "[" + events.joined(separator: ",") + "]"
        return try JSONDecoder.relay().decode([CardEvent].self, from: Data(json.utf8))
    }

    func testEventsBecomeOneRowPerCardNewestFirst() throws {
        // The relay serves newest first; a thread keeps that order and the
        // threads sort by their latest event.
        let events = try decode([
            event("e3", card: "c-1", type: "decided", at: "2026-09-11T09:00:00.000Z", action: "decline", actor: "toru",
                  note: "Not until the lease is settled", snapshot: wholeCard("c-1", title: "Supplier price +8%", status: "rejected", decided: true)),
            event("e2", card: "c-2", type: "created", at: "2026-09-11T08:00:00.000Z", actor: "kenji",
                  snapshot: wholeCard("c-2", title: "Menu photos", status: "pending", decided: false)),
            event("e1", card: "c-1", type: "created", at: "2026-09-10T08:00:00Z", actor: "mika",
                  snapshot: wholeCard("c-1", title: "Supplier price +8%", status: "pending", decided: false)),
        ])
        let threads = HistoryThread.threads(from: events)
        XCTAssertEqual(threads.map(\.id), ["c-1", "c-2"])
        XCTAssertEqual(threads[0].events.map(\.id), ["e3", "e1"])
        XCTAssertEqual(threads[0].latest.headline, String(localized: "Declined"))
        XCTAssertEqual(threads[0].title, "Supplier price +8%")
        XCTAssertTrue(threads[0].isDecided)
        XCTAssertFalse(threads[1].isDecided)
        XCTAssertTrue(threads[1].isWaiting)
        XCTAssertEqual(threads[0].actors, ["toru", "mika"])
        // The card comes back whole from the newest event that had it —
        // with its decision, so the sheet can draft the reply.
        XCTAssertEqual(threads[0].card?.decision?.replyText, "Not until the lease is settled")
        XCTAssertEqual(threads[0].card?.sourceApp, "Gmail")
        XCTAssertEqual(threads[0].card?.createdAt, ISO8601DateFormatter.relayStandard.date(from: "2026-09-10T08:00:00Z"))
    }

    func testTheFeedsCopyWinsOverTheEvents() throws {
        let events = try decode([
            event("e1", card: "c-1", type: "created", at: "2026-09-10T08:00:00Z", actor: "mika",
                  snapshot: wholeCard("c-1", title: "Supplier price +8%", status: "pending", decided: false)),
        ])
        let live = try JSONDecoder.relay().decode(DecisionCard.self, from: Data(wholeCard("c-1", title: "Supplier price +8%", status: "rejected", decided: true).utf8))
        let threads = HistoryThread.threads(from: events) { $0 == "c-1" ? live : nil }
        XCTAssertTrue(threads[0].isDecided)
        XCTAssertEqual(threads[0].status, "rejected")
    }

    func testAnEventThatRecordedLessStillReads() throws {
        // An older event's snapshot has a title and a status and no more.
        // The row reads; it does not open.
        let events = try decode([
            event("e1", card: "c-9", type: "decided", at: "2026-09-01T08:00:00Z", action: "approve", actor: "toru",
                  snapshot: #"{"title":"Old one","status":"approved"}"#),
        ])
        XCTAssertNil(events[0].card)
        XCTAssertEqual(events[0].snapshot?.title, "Old one")
        let thread = HistoryThread.threads(from: events)[0]
        XCTAssertNil(thread.card)
        XCTAssertEqual(thread.title, "Old one")
        XCTAssertTrue(thread.isDecided)
    }

    func testFiltersAndSearch() throws {
        let events = try decode([
            event("e4", card: "c-3", type: "rolled_back", at: "2026-09-12T08:00:00Z", actor: "toru",
                  snapshot: wholeCard("c-3", title: "Lease renewal", status: "pending", decided: false)),
            event("e3", card: "c-1", type: "replied", at: "2026-09-11T10:00:00Z", actor: "toru", note: "Mika, not this time.",
                  snapshot: wholeCard("c-1", title: "Supplier price +8%", status: "rejected", decided: true)),
            event("e2", card: "c-2", type: "created", at: "2026-09-11T08:00:00Z", actor: "kenji",
                  snapshot: wholeCard("c-2", title: "Menu photos", status: "pending", decided: false)),
        ])
        let threads = HistoryThread.threads(from: events)
        XCTAssertEqual(threads.filter(HistoryFilter.decided.matches).map(\.id), ["c-1"])
        XCTAssertEqual(threads.filter(HistoryFilter.waiting.matches).map(\.id), ["c-3", "c-2"])
        XCTAssertEqual(threads.filter(HistoryFilter.undone.matches).map(\.id), ["c-3"])
        // Every fixture card's summary names Mika; the note does not repeat.
        XCTAssertEqual(threads.filter { $0.matches("not this time") }.map(\.id), ["c-1"]) // the note
        XCTAssertEqual(threads.filter { $0.matches("mika") }.count, 3)                    // the summary
        XCTAssertEqual(threads.filter { $0.matches("KENJI") }.map(\.id), ["c-2"])  // the actor
        XCTAssertEqual(threads.filter { $0.matches("photos") }.map(\.id), ["c-2"]) // the title
        XCTAssertEqual(threads.filter { $0.matches("  ") }.count, 3)
        XCTAssertEqual(threads[1].latest.headline, String(localized: "Reply sent"))
    }
}
