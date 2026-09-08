import Foundation

/// Local evidence of a send attempt. Only a matching relay echo or snapshot
/// confirms it; an unrelated enrichment of the same card does not.
struct PendingCardDelivery: Codable {
    enum Operation: String, Codable { case create, decision, rollback }
    let card: DecisionCard
    let operation: Operation

    func matches(_ actual: DecisionCard) -> Bool {
        guard actual.id == card.id, actual.recipientUserID == card.recipientUserID,
              actual.senderUserID == card.senderUserID else { return false }
        switch operation {
        case .create:
            return actual.title == card.title && actual.summary == card.summary && actual.context == card.context
                && actual.type == card.type && actual.priority == card.priority && actual.videoURL == card.videoURL
        case .decision:
            guard let expected = card.decision, let received = actual.decision else { return false }
            return actual.status == card.status && received.action == expected.action
                && received.actorUserID == expected.actorUserID && received.optionId == expected.optionId
                && received.note == expected.note && received.replyText == expected.replyText
        case .rollback:
            return actual.status == .pending && actual.decision == nil
        }
    }
}
