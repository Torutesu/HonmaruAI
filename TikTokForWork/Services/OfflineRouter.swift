import Foundation

/// Routes an instruction without the relay.
///
/// The relay does this better, with an LLM and the whole org graph. This exists
/// so a dead network costs you quality rather than the ability to file anything
/// at all — which matters most in exactly the situation where you cannot fix it,
/// like standing in front of someone with a phone in your hand.
enum OfflineRouter {
    /// Keyword tables mirroring the relay's, kept deliberately small. Anything
    /// this cannot place goes to the owner, which in a one-person business is
    /// the right answer far more often than it is wrong.
    private static let designWords = ["ロゴ", "バナー", "デザイン", "画像", "ヒーロー",
                                      "logo", "banner", "design", "mockup", "figma"]
    private static let clientWords = ["納品", "検収", "先方", "クライアント", "承認依頼",
                                      "client", "delivery", "sign-off"]

    static func draft(
        text: String,
        sender: User,
        priority: CardPriority
    ) -> InstructionDraft {
        let lower = text.lowercased()

        let recipient: String
        let reason: String
        if designWords.contains(where: { lower.contains($0.lowercased()) }) {
            recipient = "user-yui"
            reason = String(localized: "Visual work goes to the contractor")
        } else if clientWords.contains(where: { lower.contains($0.lowercased()) }) {
            recipient = "user-tanaka"
            reason = String(localized: "The client has to agree to this")
        } else {
            recipient = sender.id
            reason = String(localized: "This one is yours to decide")
        }

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
