import Foundation

enum CardType: String, Codable, CaseIterable {
    case approval
    case delegation
    case notification
    case task
    case revision

    var label: String {
        switch self {
        case .approval: "Approval"
        case .delegation: "Delegation"
        case .notification: "Update"
        case .task: "Task"
        case .revision: "Revision"
        }
    }
}

enum CardStatus: String, Codable {
    case pending
    case approved
    case rejected
    case revised
    case delegated

    var label: String {
        switch self {
        case .pending: "Pending"
        case .approved: "Issue created"
        case .rejected: "Declined"
        case .revised: "Revision requested"
        case .delegated: "Delegated"
        }
    }
}

enum CardPriority: String, Codable, CaseIterable {
    case low
    case medium
    case high
    case urgent
}

enum CardActionKind {
    case createIssue
    case reject
    case requestRevision
    case delegate
    case viewDetails
}

struct DecisionCard: Identifiable, Codable, Hashable {
    let id: String
    let recipientUserID: String
    let senderUserID: String
    var type: CardType
    var title: String
    var summary: String
    var context: String
    var status: CardStatus
    var priority: CardPriority
    var createdAt: Date
    var githubIssueNumber: Int?
    var githubIssueURL: String?
    var agentRoute: String?
    var routingReason: String?
    var sourceInstruction: String?
    var labels: [String]?
    var revisionNote: String?

    var isPending: Bool { status == .pending }

    var priorityLabel: String {
        switch priority {
        case .low: "Low"
        case .medium: "Medium"
        case .high: "High"
        case .urgent: "Urgent"
        }
    }

    var senderName: String {
        DemoData.userName(for: senderUserID)
    }
}
