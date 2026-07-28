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
}

enum InstructionRouter {
    static func route(text: String, sender: User, organization: OrganizationGraph) -> InstructionRouting {
        let lowercased = text.lowercased()
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)

        let recipientID: String
        let namedInInstruction: Bool
        if lowercased.contains("bob") {
            recipientID = "user-bob"
            namedInInstruction = true
        } else if lowercased.contains("alice") {
            recipientID = "user-alice"
            namedInInstruction = true
        } else if lowercased.contains("manager"), let manager = organization.manager(of: sender.id) {
            recipientID = manager.id
            namedInInstruction = false
        } else {
            recipientID = sender.id == "user-alice" ? "user-bob" : "user-alice"
            namedInInstruction = false
        }

        let cardType: CardType
        if lowercased.contains("approve") || lowercased.contains("approval") {
            cardType = .approval
        } else if lowercased.contains("delegate") || lowercased.contains("assign") {
            cardType = .delegation
        } else if lowercased.contains("revise") || lowercased.contains("feedback") {
            cardType = .revision
        } else if lowercased.contains("task") || lowercased.contains("fix") || lowercased.contains("build") {
            cardType = .task
        } else {
            cardType = .notification
        }

        let recipientName = DemoData.userName(for: recipientID)
        let title: String
        switch cardType {
        case .approval: title = "Approval requested"
        case .delegation: title = "Task delegated"
        case .revision: title = "Revision requested"
        case .task: title = "New task"
        case .notification: title = "Routed update"
        }

        return InstructionRouting(
            recipientID: recipientID,
            cardType: cardType,
            title: title,
            summary: trimmed,
            context: "To \(recipientName) · via \(sender.name)",
            priority: lowercased.contains("urgent") ? .urgent : .high,
            agentRoute: "\(sender.name)'s AI → \(recipientName)'s AI",
            routingReason: organization.routingReason(
                recipientID: recipientID,
                senderID: sender.id,
                namedInInstruction: namedInInstruction
            )
        )
    }
}
