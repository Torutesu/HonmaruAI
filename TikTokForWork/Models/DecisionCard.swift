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
    /// "I have read this." The answer to an update, which is not a decision and
    /// must not be treated as one — see `DecisionCard.isDecision`.
    case acknowledge
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
    /// Who asked in the first place, when this card is a hand-on of someone
    /// else's request.
    ///
    /// A delegated card's sender is whoever handed it over, so A → B → C left A
    /// watching a card that said "delegated" and never hearing what C decided.
    /// The chain keeps the first name so the answer can reach the person who
    /// actually needed it.
    var originSenderUserID: String?
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
    /// The decision is recorded, but GitHub has not heard about it yet. Set when
    /// a sync fails — offline, rate-limited, GitHub down — and cleared when it
    /// lands. Approving used to wait on GitHub before the decision existed at
    /// all, so a decision made on a train was not made.
    var githubSyncPending: Bool?

    var isPending: Bool { status == .pending }

    /// Whether this card asks its recipient to decide something.
    ///
    /// An update — "Grace approved your budget" — is not a decision. It used to
    /// arrive as one: pending, with Approve, Decline, Revise and Delegate under
    /// it, counted on the badge, and approving it created a GitHub issue and a
    /// fresh update back to the person who had just decided. Two people could
    /// approve each other's approvals indefinitely.
    var isDecision: Bool { type != .notification }

    /// Someone is waiting on this. What the badge and the tab count mean.
    var needsDecision: Bool { isPending && isDecision }

    /// Whole days this has been waiting on someone, or nil while it is still
    /// today's problem.
    ///
    /// A decision nobody makes is the failure mode this product replaces, and it
    /// is silent by construction: the card just sits there looking the same on
    /// day six as it did on day one. One day is not late — a card that arrived
    /// this morning should not wear a warning — so the count starts at two.
    var waitingDays: Int? {
        guard needsDecision else { return nil }
        let days = Calendar.current.dateComponents([.day], from: createdAt, to: .now).day ?? 0
        return days >= 2 ? days : nil
    }

    /// Waiting long enough that the delay is now the story, not the decision.
    var isStale: Bool { (waitingDays ?? 0) >= 5 }

    /// A card you can clear away: one you declined, or an update you have read.
    /// Never a pending decision — deleting that drops work someone is waiting
    /// on — and never an approved one, which is a record.
    var canDelete: Bool { status == .rejected || (!isDecision && !isPending) }

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

    /// Everyone with a stake in this decision: the person who has to make it,
    /// the person who asked, and — down a delegation chain — the person who
    /// asked first.
    var parties: [String] {
        [recipientUserID, senderUserID, originSenderUserID].compactMap { $0 }
    }

    func showsGitHubLink(for repository: String) -> Bool {
        guard let githubIssueURL, !repository.isEmpty else { return false }
        if let githubRepository {
            return githubRepository == repository
        }
        return githubIssueURL.contains("github.com/\(repository)/")
    }
}

/// Decoding a card the way the relay stores one.
///
/// In an extension, not the struct body: an initializer written inside a struct
/// suppresses the memberwise one, and every place in the app that builds a card
/// uses it.
extension DecisionCard {
    /// Swift's synthesized decoder requires every non-optional field. The relay
    /// requires two — an id and a recipient — and accepts the rest as absent: a
    /// connector-ingested item with no summary, a card from the reference web
    /// client with no explicit status, a value in an enum this build has never
    /// heard of. Each of those made the whole card fail to decode, and a card
    /// that fails to decode is a decision that never appears on anyone's phone.
    /// Better an empty summary than a missing decision.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try c.decode(String.self, forKey: .id),
            recipientUserID: try c.decode(String.self, forKey: .recipientUserID),
            senderUserID: (try? c.decodeIfPresent(String.self, forKey: .senderUserID)) ?? "",
            originSenderUserID: (try? c.decodeIfPresent(String.self, forKey: .originSenderUserID)),
            // A value this build does not know is shown as the nearest thing it
            // does. `decodeIfPresent` throws on an unrecognised raw value, so
            // these go through `try?` rather than trusting it to return nil.
            type: (try? c.decodeIfPresent(CardType.self, forKey: .type)) ?? .task,
            title: (try? c.decodeIfPresent(String.self, forKey: .title)) ?? "",
            summary: (try? c.decodeIfPresent(String.self, forKey: .summary)) ?? "",
            context: (try? c.decodeIfPresent(String.self, forKey: .context)) ?? "",
            status: (try? c.decodeIfPresent(CardStatus.self, forKey: .status)) ?? .pending,
            priority: (try? c.decodeIfPresent(CardPriority.self, forKey: .priority)) ?? .medium,
            createdAt: (try? c.decodeIfPresent(Date.self, forKey: .createdAt)) ?? Date(),
            githubIssueNumber: (try? c.decodeIfPresent(Int.self, forKey: .githubIssueNumber)),
            githubIssueURL: (try? c.decodeIfPresent(String.self, forKey: .githubIssueURL)),
            githubRepository: (try? c.decodeIfPresent(String.self, forKey: .githubRepository)),
            agentRoute: (try? c.decodeIfPresent(String.self, forKey: .agentRoute)),
            routingReason: (try? c.decodeIfPresent(String.self, forKey: .routingReason)),
            sourceInstruction: (try? c.decodeIfPresent(String.self, forKey: .sourceInstruction)),
            labels: (try? c.decodeIfPresent([String].self, forKey: .labels)),
            revisionNote: (try? c.decodeIfPresent(String.self, forKey: .revisionNote)),
            sourceApp: (try? c.decodeIfPresent(String.self, forKey: .sourceApp)),
            sourceDetail: (try? c.decodeIfPresent(String.self, forKey: .sourceDetail)),
            originalBody: (try? c.decodeIfPresent(String.self, forKey: .originalBody)),
            originalLanguage: (try? c.decodeIfPresent(String.self, forKey: .originalLanguage)),
            videoURL: (try? c.decodeIfPresent(String.self, forKey: .videoURL)),
            decision: (try? c.decodeIfPresent(Decision.self, forKey: .decision)),
            githubSyncPending: (try? c.decodeIfPresent(Bool.self, forKey: .githubSyncPending))
        )
    }
}
