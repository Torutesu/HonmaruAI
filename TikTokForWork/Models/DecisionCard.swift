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

struct Decision: Codable, Hashable {
    let action: String
    let optionId: String?
    let note: String?
    let replyText: String?
    let actorUserID: String
    let decidedAt: Date
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
    /// The uploaded video the sender recorded alongside this decision.
    var videoURL: String?
    /// The decision made on this card (if decided). Present only after the card has been actioned.
    var decision: Decision?

    var isPending: Bool { status == .pending }

    /// Whole days this has been waiting on someone, or nil while it is still
    /// today's problem.
    ///
    /// A decision nobody makes is the failure mode this product replaces, and it
    /// is silent by construction: the card just sits there looking the same on
    /// day six as it did on day one. One day is not late — a card that arrived
    /// this morning should not wear a warning — so the count starts at two.
    var waitingDays: Int? {
        guard isPending else { return nil }
        let days = Calendar.current.dateComponents([.day], from: createdAt, to: .now).day ?? 0
        return days >= 2 ? days : nil
    }

    /// Waiting long enough that the delay is now the story, not the decision.
    var isStale: Bool { (waitingDays ?? 0) >= 5 }

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
        DisplayName.of(senderUserID)
    }

    func showsGitHubLink(for repository: String) -> Bool {
        guard let githubIssueURL, !repository.isEmpty else { return false }
        if let githubRepository {
            return githubRepository == repository
        }
        return githubIssueURL.contains("github.com/\(repository)/")
    }
}
