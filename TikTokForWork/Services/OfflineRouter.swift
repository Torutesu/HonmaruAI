import Foundation

/// Preserves the author's words as an editable manual draft. Recipient selection
/// is explicit; an offline fallback never invents people from keyword matches.
enum OfflineRouter {
    static func draft(text: String, sender: User, priority: CardPriority, recipientUserID: String? = nil) -> InstructionDraft {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let recipient = recipientUserID ?? sender.id
        let firstLine = trimmed.split(separator: "\n").first.map(String.init) ?? trimmed
        let title = firstLine.count > 72 ? String(firstLine.prefix(72)) + "…" : firstLine
        return InstructionDraft(
            id: UUID().uuidString, sourceText: text, recipientUserID: recipient,
            cardType: .approval, title: title, summary: trimmed, context: "", priority: priority,
            agentRoute: "", routingReason: String(localized: "Selected by you"), labels: [], toolCalls: []
        )
    }
}
