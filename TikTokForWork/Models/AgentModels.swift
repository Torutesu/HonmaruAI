import Foundation

struct InstructionRouting {
    let recipientID: String
    let cardType: CardType
    let title: String
    let summary: String
    let context: String
    let priority: CardPriority
    let agentRoute: String
    let routingReason: String
    let labels: [String]
    let toolCalls: [AgentToolCall]
}

struct AgentToolCall: Identifiable, Codable, Hashable {
    let name: String
    let label: String
    let detail: String

    var id: String { "\(name)-\(detail)" }

    var icon: String {
        switch name {
        case "create_decision_card": "arrow.triangle.branch"
        case "set_priority": "slider.horizontal.3"
        case "add_context": "text.append"
        default: "sparkle"
        }
    }
}

struct InstructionDraft: Identifiable, Codable, Hashable {
    let id: String
    let sourceText: String
    let recipientUserID: String
    let cardType: CardType
    let title: String
    let summary: String
    let context: String
    let priority: CardPriority
    let agentRoute: String
    let routingReason: String
    let labels: [String]
    let toolCalls: [AgentToolCall]

    var recipientName: String {
        OrgLookup.shared.name(for: recipientUserID)
    }

    func asRouting() -> InstructionRouting {
        InstructionRouting(
            recipientID: recipientUserID,
            cardType: cardType,
            title: title,
            summary: summary,
            context: context,
            priority: priority,
            agentRoute: agentRoute,
            routingReason: routingReason,
            labels: labels,
            toolCalls: toolCalls
        )
    }
}
