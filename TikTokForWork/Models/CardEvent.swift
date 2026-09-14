import Foundation

/// One entry in a card's history, as served by the relay's event log.
struct CardEvent: Identifiable, Decodable, Equatable {
    let id: String
    let cardId: String
    let type: String
    let action: String?
    let actorUserId: String?
    let note: String?
    let createdAt: String
    let snapshot: Snapshot?
    /// The card as it was at that moment, when the snapshot is a whole card
    /// (every event the relay writes today carries one). Nil for an older
    /// event that recorded less — the row still reads, it just cannot open.
    let card: DecisionCard?

    /// Only the parts of the recorded card the history row shows.
    struct Snapshot: Decodable, Equatable {
        let title: String?
        let status: String?
    }

    init(id: String, cardId: String, type: String, action: String? = nil, actorUserId: String? = nil,
         note: String? = nil, createdAt: String, snapshot: Snapshot? = nil, card: DecisionCard? = nil) {
        self.id = id
        self.cardId = cardId
        self.type = type
        self.action = action
        self.actorUserId = actorUserId
        self.note = note
        self.createdAt = createdAt
        self.snapshot = snapshot
        self.card = card
    }

    private enum CodingKeys: String, CodingKey {
        case id, cardId, type, action, actorUserId, note, createdAt, snapshot
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        cardId = try c.decode(String.self, forKey: .cardId)
        type = try c.decode(String.self, forKey: .type)
        action = try c.decodeIfPresent(String.self, forKey: .action)
        actorUserId = try c.decodeIfPresent(String.self, forKey: .actorUserId)
        note = try c.decodeIfPresent(String.self, forKey: .note)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        snapshot = try c.decodeIfPresent(Snapshot.self, forKey: .snapshot)
        // The same bytes read twice: the row's two fields always, the whole
        // card when it is one. A snapshot that is not a card is not an error.
        card = try? c.decodeIfPresent(DecisionCard.self, forKey: .snapshot)
    }

    /// "Approved" reads better than "decided" when both are present.
    var headline: String {
        switch type {
        case "created": return String(localized: "Created")
        case "updated": return String(localized: "Updated")
        case "deleted": return String(localized: "Deleted")
        case "rolled_back": return String(localized: "Undone")
        case "nudged": return String(localized: "Nudged")
        case "asked": return String(localized: "Asked your AI")
        case "drafted": return String(localized: "Reply drafted")
        case "replied": return String(localized: "Reply sent")
        case "filed": return String(localized: "Filed")
        case "decided":
            switch action {
            case "approve": return String(localized: "Approved")
            case "decline": return String(localized: "Declined")
            case "reply": return String(localized: "Replied")
            case "revise": return String(localized: "Revision asked")
            case "delegate": return String(localized: "Delegated")
            default: return String(localized: "Decided")
            }
        default: return type
        }
    }
}
