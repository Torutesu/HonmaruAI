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
    case completed
    case resent
    case acknowledged

    var label: String {
        switch self {
        case .pending: "Pending"
        case .approved: "Issue created"
        case .rejected: "Declined"
        case .revised: "Revision requested"
        case .delegated: "Delegated"
        case .completed: "Closed on GitHub"
        case .resent: "Revised and resent"
        case .acknowledged: "Read"
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
    case delete
    case askAI
    case reviseResend
    case reply
    case acknowledge
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
    var githubRepository: String?
    var agentRoute: String?
    var routingReason: String?
    var sourceInstruction: String?
    var labels: [String]?
    var revisionNote: String?
    var channelID: String?
    // Server-side SLA marker — round-tripped so client updates don't clear it.
    var escalatedAt: String?

    var isPending: Bool { status == .pending }

    var canDelete: Bool { status == .rejected }

    // A revision request bounced back to the original sender — actionable, unlike
    // AI-routed .revision cards which carry no revisionNote.
    var isRevisionRequest: Bool { type == .revision && revisionNote != nil }

    // Updates, questions, and notes: reply or mark as read, never "create issue".
    var isNotification: Bool { type == .notification }

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

    func showsGitHubLink(for repository: String) -> Bool {
        guard let githubIssueURL, !repository.isEmpty else { return false }
        if let githubRepository {
            return githubRepository == repository
        }
        return githubIssueURL.contains("github.com/\(repository)/")
    }
}
