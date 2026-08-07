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

    var label: String {
        switch self {
        case .pending: "Pending"
        case .approved: "Approved"
        case .rejected: "Declined"
        case .revised: "Revision requested"
        case .delegated: "Delegated"
        case .completed: "Completed"
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

// A card's reflection in an external system (protocol v1 `externalRefs`).
struct ExternalRef: Codable, Hashable {
    let integration: String
    let externalId: String
    let url: String?
    let state: String?
}

// Protocol v1 decision card. Field names keep the existing Swift style;
// CodingKeys map to the schema in backend/packages/protocol.
struct DecisionCard: Identifiable, Codable, Hashable {
    let id: String
    var orgId: String
    let recipientUserID: String
    let senderUserID: String
    var type: CardType
    var title: String
    var summary: String
    var context: String
    var status: CardStatus
    var priority: CardPriority
    var createdAt: Date
    var updatedAt: Date
    var dueAt: Date?
    var escalatedAt: Date?
    var agentRoute: String?
    var routingReason: String?
    var sourceInstruction: String?
    var labels: [String]?
    var revisionNote: String?
    var parentCardId: String?
    var externalRefs: [ExternalRef]

    enum CodingKeys: String, CodingKey {
        case id, orgId
        case recipientUserID = "recipientUserId"
        case senderUserID = "senderUserId"
        case type, title, summary, context, status, priority
        case createdAt, updatedAt, dueAt, escalatedAt
        case agentRoute, routingReason, sourceInstruction
        case labels, revisionNote, parentCardId, externalRefs
    }

    init(
        id: String,
        orgId: String = "",
        recipientUserID: String,
        senderUserID: String,
        type: CardType,
        title: String,
        summary: String,
        context: String,
        status: CardStatus,
        priority: CardPriority,
        createdAt: Date,
        updatedAt: Date? = nil,
        dueAt: Date? = nil,
        escalatedAt: Date? = nil,
        agentRoute: String? = nil,
        routingReason: String? = nil,
        sourceInstruction: String? = nil,
        labels: [String]? = nil,
        revisionNote: String? = nil,
        parentCardId: String? = nil,
        externalRefs: [ExternalRef] = []
    ) {
        self.id = id
        self.orgId = orgId
        self.recipientUserID = recipientUserID
        self.senderUserID = senderUserID
        self.type = type
        self.title = title
        self.summary = summary
        self.context = context
        self.status = status
        self.priority = priority
        self.createdAt = createdAt
        self.updatedAt = updatedAt ?? createdAt
        self.dueAt = dueAt
        self.escalatedAt = escalatedAt
        self.agentRoute = agentRoute
        self.routingReason = routingReason
        self.sourceInstruction = sourceInstruction
        self.labels = labels
        self.revisionNote = revisionNote
        self.parentCardId = parentCardId
        self.externalRefs = externalRefs
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        orgId = try container.decodeIfPresent(String.self, forKey: .orgId) ?? ""
        recipientUserID = try container.decode(String.self, forKey: .recipientUserID)
        senderUserID = try container.decode(String.self, forKey: .senderUserID)
        type = try container.decode(CardType.self, forKey: .type)
        title = try container.decode(String.self, forKey: .title)
        summary = try container.decode(String.self, forKey: .summary)
        context = try container.decode(String.self, forKey: .context)
        status = try container.decode(CardStatus.self, forKey: .status)
        priority = try container.decode(CardPriority.self, forKey: .priority)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        updatedAt = try container.decodeIfPresent(Date.self, forKey: .updatedAt) ?? createdAt
        dueAt = try container.decodeIfPresent(Date.self, forKey: .dueAt)
        escalatedAt = try container.decodeIfPresent(Date.self, forKey: .escalatedAt)
        agentRoute = try container.decodeIfPresent(String.self, forKey: .agentRoute)
        routingReason = try container.decodeIfPresent(String.self, forKey: .routingReason)
        sourceInstruction = try container.decodeIfPresent(String.self, forKey: .sourceInstruction)
        labels = try container.decodeIfPresent([String].self, forKey: .labels)
        revisionNote = try container.decodeIfPresent(String.self, forKey: .revisionNote)
        parentCardId = try container.decodeIfPresent(String.self, forKey: .parentCardId)
        externalRefs = try container.decodeIfPresent([ExternalRef].self, forKey: .externalRefs) ?? []
    }

    var isPending: Bool { status == .pending }

    var canDelete: Bool { status == .rejected }

    var isOverdue: Bool {
        guard let dueAt, status == .pending else { return false }
        return dueAt < .now
    }

    var priorityLabel: String {
        switch priority {
        case .low: "Low"
        case .medium: "Medium"
        case .high: "High"
        case .urgent: "Urgent"
        }
    }

    @MainActor
    var senderName: String {
        OrgDirectory.shared.name(for: senderUserID)
    }

    // GitHub sync is now one of many server-side integrations; these read
    // the generic externalRefs so existing views keep working.
    private var githubRef: ExternalRef? {
        externalRefs.first { $0.integration == "github_issues" }
    }

    var githubIssueNumber: Int? {
        githubRef.flatMap { Int($0.externalId) }
    }

    var githubIssueURL: String? {
        githubRef?.url
    }

    func showsGitHubLink(for repository: String) -> Bool {
        githubIssueURL != nil
    }
}
