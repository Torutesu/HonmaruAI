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

    /// Only the parts of the recorded card the history screen shows.
    struct Snapshot: Decodable, Equatable {
        let title: String?
        let status: String?
    }

    /// "Approved" reads better than "decided" when both are present.
    var headline: String {
        switch type {
        case "created": return String(localized: "Created")
        case "updated": return String(localized: "Updated")
        case "deleted": return String(localized: "Deleted")
        case "rolled_back": return String(localized: "Undone")
        case "decided":
            switch action {
            case "approve": return String(localized: "Approved")
            case "decline": return String(localized: "Declined")
            case "reply": return String(localized: "Replied")
            default: return String(localized: "Decided")
            }
        default: return type
        }
    }
}
