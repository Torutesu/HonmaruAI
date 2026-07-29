import Foundation

enum DemoUser: String, CaseIterable, Identifiable {
    case alice
    case bob

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .alice: "Alice"
        case .bob: "Bob"
        }
    }

    var subtitle: String {
        switch self {
        case .alice: "PM"
        case .bob: "Engineering"
        }
    }

    var user: User {
        switch self {
        case .alice:
            User(id: "user-alice", name: "Alice", role: "Product Manager", teamID: "team-core", githubUsername: "alice")
        case .bob:
            User(id: "user-bob", name: "Bob", role: "Engineer", teamID: "team-core", githubUsername: "bob")
        }
    }
}

enum DemoData {
    static let organization = OrganizationGraph(
        nodes: [
            OrgNode(id: "user-alice", kind: .person, label: "Alice"),
            OrgNode(id: "user-bob", kind: .person, label: "Bob"),
            OrgNode(id: "agent-alice", kind: .agent, label: "Alice's AI"),
            OrgNode(id: "agent-bob", kind: .agent, label: "Bob's AI"),
            OrgNode(id: "team-core", kind: .team, label: "Core Team"),
            OrgNode(id: "project-onboarding", kind: .project, label: "Onboarding v2")
        ],
        edges: [
            OrgEdge(id: "e1", fromID: "user-alice", toID: "team-core", kind: .memberOf),
            OrgEdge(id: "e2", fromID: "user-bob", toID: "team-core", kind: .memberOf),
            OrgEdge(id: "e3", fromID: "user-alice", toID: "user-bob", kind: .manages),
            OrgEdge(id: "e4", fromID: "user-alice", toID: "project-onboarding", kind: .canApprove),
            OrgEdge(id: "e5", fromID: "agent-alice", toID: "user-alice", kind: .assignedTo),
            OrgEdge(id: "e6", fromID: "agent-bob", toID: "user-bob", kind: .assignedTo)
        ]
    )

    static let initialCards: [String: [DecisionCard]] = [
        "user-bob": [
            DecisionCard(
                id: "card-seed-1",
                recipientUserID: "user-bob",
                senderUserID: "user-alice",
                type: .approval,
                title: "Approve onboarding PR",
                summary: "Review onboarding redesign before tomorrow's merge window.",
                context: "PR #42 · QA passed on staging",
                status: .pending,
                priority: .high,
                createdAt: .now.addingTimeInterval(-3600),
                githubIssueNumber: nil,
                githubIssueURL: nil,
                agentRoute: "Alice's AI → Bob's AI",
                routingReason: "Approval authority on Onboarding v2"
            )
        ],
        "user-alice": [
            DecisionCard(
                id: "card-seed-2",
                recipientUserID: "user-alice",
                senderUserID: "user-bob",
                type: .task,
                title: "Auth latency regression",
                summary: "p95 on auth endpoint up 18% after last deploy.",
                context: "Hotfix branch recommended before Friday demo",
                status: .pending,
                priority: .urgent,
                createdAt: .now.addingTimeInterval(-1800),
                githubIssueNumber: nil,
                githubIssueURL: nil,
                agentRoute: "Bob's AI → Alice's AI",
                routingReason: "You are Bob's manager"
            )
        ]
    ]

    static func user(for id: String) -> User? {
        DemoUser.allCases.map(\.user).first { $0.id == id }
    }

    static func userName(for userID: String) -> String {
        switch userID {
        case "user-alice": "Alice"
        case "user-bob": "Bob"
        default: userID
        }
    }

    static func agentName(for userID: String) -> String {
        "\(userName(for: userID))'s AI"
    }
}
