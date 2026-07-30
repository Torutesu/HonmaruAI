import Foundation

enum DemoUser: String, CaseIterable, Identifiable {
    case alice
    case bob
    case carol
    case dana

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .alice: "Alice"
        case .bob: "Bob"
        case .carol: "Carol"
        case .dana: "Dana"
        }
    }

    var subtitle: String {
        switch self {
        case .alice: "Product"
        case .bob: "Engineering"
        case .carol: "Design"
        case .dana: "Eng Lead"
        }
    }

    var user: User {
        switch self {
        case .alice:
            User(id: "user-alice", name: "Alice", role: "Product Manager", teamID: "team-core", githubUsername: "alice")
        case .bob:
            User(id: "user-bob", name: "Bob", role: "Engineer", teamID: "team-core", githubUsername: "bob")
        case .carol:
            User(id: "user-carol", name: "Carol", role: "Designer", teamID: "team-core", githubUsername: "carol")
        case .dana:
            User(id: "user-dana", name: "Dana", role: "Engineering Lead", teamID: "team-core", githubUsername: "dana")
        }
    }
}

// Runtime directory for the organization. Seeded with the demo roster and
// replaced by the relay's org once fetched (OrganizationService.apply).
enum OrgDirectory {
    private(set) static var users: [User] = DemoUser.allCases.map(\.user)

    static var teamUserIDs: [String] { users.map(\.id) }

    static func apply(users: [User], organization: OrganizationGraph) {
        self.users = users
        self.organization = organization
    }

    private(set) static var organization = OrganizationGraph(
        nodes: [
            OrgNode(id: "user-alice", kind: .person, label: "Alice · Product"),
            OrgNode(id: "user-bob", kind: .person, label: "Bob · Engineering"),
            OrgNode(id: "user-carol", kind: .person, label: "Carol · Design"),
            OrgNode(id: "user-dana", kind: .person, label: "Dana · Eng Lead"),
            OrgNode(id: "agent-alice", kind: .agent, label: "Alice's AI"),
            OrgNode(id: "agent-bob", kind: .agent, label: "Bob's AI"),
            OrgNode(id: "agent-carol", kind: .agent, label: "Carol's AI"),
            OrgNode(id: "agent-dana", kind: .agent, label: "Dana's AI"),
            OrgNode(id: "team-core", kind: .team, label: "Core Team"),
            OrgNode(id: "team-design", kind: .team, label: "Design Team"),
            OrgNode(id: "team-engineering", kind: .team, label: "Engineering"),
            OrgNode(id: "team-product", kind: .team, label: "Product"),
            OrgNode(id: "project-onboarding", kind: .project, label: "Onboarding v2")
        ],
        edges: [
            OrgEdge(id: "e1", fromID: "user-alice", toID: "team-core", kind: .memberOf),
            OrgEdge(id: "e2", fromID: "user-bob", toID: "team-core", kind: .memberOf),
            OrgEdge(id: "e3", fromID: "user-carol", toID: "team-core", kind: .memberOf),
            OrgEdge(id: "e4", fromID: "user-dana", toID: "team-core", kind: .memberOf),
            OrgEdge(id: "e13", fromID: "user-carol", toID: "team-design", kind: .memberOf),
            OrgEdge(id: "e14", fromID: "user-bob", toID: "team-engineering", kind: .memberOf),
            OrgEdge(id: "e15", fromID: "user-dana", toID: "team-engineering", kind: .memberOf),
            OrgEdge(id: "e16", fromID: "user-alice", toID: "team-product", kind: .memberOf),
            OrgEdge(id: "e5", fromID: "user-alice", toID: "user-bob", kind: .manages),
            OrgEdge(id: "e6", fromID: "user-dana", toID: "user-bob", kind: .manages),
            OrgEdge(id: "e7", fromID: "user-alice", toID: "project-onboarding", kind: .canApprove),
            OrgEdge(id: "e8", fromID: "user-dana", toID: "project-onboarding", kind: .canApprove),
            OrgEdge(id: "e9", fromID: "agent-alice", toID: "user-alice", kind: .assignedTo),
            OrgEdge(id: "e10", fromID: "agent-bob", toID: "user-bob", kind: .assignedTo),
            OrgEdge(id: "e11", fromID: "agent-carol", toID: "user-carol", kind: .assignedTo),
            OrgEdge(id: "e12", fromID: "agent-dana", toID: "user-dana", kind: .assignedTo)
        ]
    )

    static let initialCards: [String: [DecisionCard]] = [:]

    static func user(for id: String) -> User? {
        users.first { $0.id == id }
    }

    static func userName(for userID: String) -> String {
        user(for: userID)?.name ?? userID
    }

    static func agentName(for userID: String) -> String {
        "\(userName(for: userID))'s AI"
    }
}

// Historical name — most call sites still say DemoData; the data is live.
typealias DemoData = OrgDirectory
