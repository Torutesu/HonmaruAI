import Foundation

enum CardType: String, Codable, CaseIterable {
    case approval
    case delegation
    case notification
    case task
    case revision

    var label: String {
        switch self {
        case .approval: String(localized: "Approval")
        case .delegation: String(localized: "Delegation")
        case .notification: String(localized: "Update")
        case .task: String(localized: "Task")
        case .revision: String(localized: "Revision")
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

    var label: String {
        switch self {
        case .pending: String(localized: "Pending")
        case .approved: String(localized: "Issue created")
        case .rejected: String(localized: "Declined")
        case .revised: String(localized: "Revision requested")
        case .delegated: String(localized: "Delegated")
        case .completed: String(localized: "Closed on GitHub")
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
    /// Where this decision came from — the tool the message was sitting in.
    /// Shown so you can see the card is a view onto real work rather than
    /// something the app invented.
    var sourceApp: String?
    /// Where inside that tool: a channel, a page title, a subject line.
    var sourceDetail: String?
    /// What the sender actually wrote, when that was not the language you read
    /// in. Kept so the card can prove it is a translation rather than ask you to
    /// take its word for it — you are deciding on someone else's words.
    var originalBody: String?
    /// BCP-47 tag of `originalBody`, used only to label the badge.
    var originalLanguage: String?
    /// Where the video recorded alongside this decision lives on the relay.
    /// Optional so a card that predates video, or one whose upload failed,
    /// still arrives intact — a missing clip must not cost you the decision.
    var videoURL: String?

    var isPending: Bool { status == .pending }

    var canDelete: Bool { status == .rejected }

    var priorityLabel: String {
        switch priority {
        case .low: String(localized: "Low")
        case .medium: String(localized: "Medium")
        case .high: String(localized: "High")
        case .urgent: String(localized: "Urgent")
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
