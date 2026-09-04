import Foundation

/// Routes an instruction without the relay.
///
/// The relay does this better, with a model and the whole org graph. This exists
/// so a dead network costs you quality rather than the ability to file anything
/// at all — which matters most in exactly the situation where you cannot fix it,
/// like standing in front of someone with a phone in your hand.
///
/// It does not guess who the card is for. It used to: two keyword tables sent
/// anything mentioning a logo to `user-yui`, and anything mentioning a delivery
/// to `user-tanaka` — colleagues who existed in a demo and in no real
/// organization. The relay stored those cards, nobody could ever decide them,
/// and the sender was told they had been routed. Offline, the honest answer is
/// that the card is yours until you say otherwise, and the review sheet is
/// where you say so.
enum OfflineRouter {
    static func draft(
        text: String,
        sender: User,
        priority: CardPriority
    ) -> InstructionDraft {
        let lower = text.lowercased()

        let recipient = sender.id
        let reason = String(localized: "Drafted offline · choose who this is for")

        let type: CardType
        if lower.contains("承認") || lower.contains("approve") {
            type = .approval
        } else if lower.contains("お願い") || lower.contains("頼") || lower.contains("delegate") {
            type = .delegation
        } else {
            type = .task
        }

        // The instruction is shown as written. Paraphrasing without a model
        // would only invent detail, and a first line of your own words is
        // clearer than a bad summary.
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let title = trimmed.count > 28 ? String(trimmed.prefix(28)) + "…" : trimmed

        return InstructionDraft(
            id: UUID().uuidString,
            sourceText: text,
            recipientUserID: recipient,
            cardType: type,
            title: title,
            summary: trimmed,
            context: String(localized: "action: drafted locally · scope: offline"),
            priority: priority,
            agentRoute: String(localized: "\(sender.name) → \(DisplayName.of(recipient))"),
            routingReason: reason,
            labels: [],
            toolCalls: []
        )
    }
}
