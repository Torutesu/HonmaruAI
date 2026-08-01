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

enum DemoData {
    static let teamUserIDs = DemoUser.allCases.map(\.user.id)

    static let organization = OrganizationGraph(
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

    /// First-session cards: what each person's AI has already triaged for them.
    /// Every card is a real, actionable decision so the first swipe teaches the product.
    static func seedCards(now: Date = .now) -> [DecisionCard] {
        [
            // Alice (default persona) — flagship card lands on top.
            DecisionCard(
                id: "seed-alice-release",
                recipientUserID: DemoUser.alice.user.id,
                senderUserID: DemoUser.dana.user.id,
                type: .approval,
                title: "Ship Onboarding v2 to production?",
                summary: "Dana's AI batched the release: 6 PRs merged, QA green on staging. It needs your go before the Friday demo.",
                context: "deadline: Friday demo · scope: 6 PRs, staging verified · action: approve to cut the release",
                status: .pending,
                priority: .urgent,
                createdAt: now.addingTimeInterval(-6 * 60),
                githubIssueNumber: nil,
                githubIssueURL: nil,
                agentRoute: "Dana's AI → Your AI",
                routingReason: "You hold release approval for Onboarding v2"
            ),
            DecisionCard(
                id: "seed-alice-latency",
                recipientUserID: DemoUser.alice.user.id,
                senderUserID: DemoUser.bob.user.id,
                type: .task,
                title: "Auth latency: rollback or hotfix?",
                summary: "p95 is up 18% since yesterday's deploy. Bob's AI drafted both paths — rollback is instant, the hotfix lands in ~2 hours.",
                context: "metric: p95 +18% · action: rollback or hotfix · deadline: today",
                status: .pending,
                priority: .high,
                createdAt: now.addingTimeInterval(-22 * 60),
                githubIssueNumber: nil,
                githubIssueURL: nil,
                agentRoute: "Bob's AI → Your AI",
                routingReason: "You are Bob's manager"
            ),
            DecisionCard(
                id: "seed-alice-illustrations",
                recipientUserID: DemoUser.alice.user.id,
                senderUserID: DemoUser.carol.user.id,
                type: .approval,
                title: "Pick the empty-state illustration set",
                summary: "Carol's AI shortlisted 3 candidates that match the flat design. Design handoff is blocked on your pick.",
                context: "scope: onboarding + feed empty states · deadline: next sprint",
                status: .pending,
                priority: .medium,
                createdAt: now.addingTimeInterval(-64 * 60),
                githubIssueNumber: nil,
                githubIssueURL: nil,
                agentRoute: "Carol's AI → Your AI",
                routingReason: "Design handoff waits on Product"
            ),

            // Bob
            DecisionCard(
                id: "seed-bob-hotfix",
                recipientUserID: DemoUser.bob.user.id,
                senderUserID: DemoUser.dana.user.id,
                type: .delegation,
                title: "Take the auth latency hotfix",
                summary: "Dana's AI split the incident: you own the hotfix branch, Dana reviews the merge.",
                context: "metric: p95 +18% · action: hotfix branch · deadline: today",
                status: .pending,
                priority: .urgent,
                createdAt: now.addingTimeInterval(-9 * 60),
                githubIssueNumber: nil,
                githubIssueURL: nil,
                agentRoute: "Dana's AI → Your AI",
                routingReason: "You shipped the auth changes yesterday"
            ),
            DecisionCard(
                id: "seed-bob-analytics",
                recipientUserID: DemoUser.bob.user.id,
                senderUserID: DemoUser.alice.user.id,
                type: .task,
                title: "Add decision analytics to the feed",
                summary: "Alice's AI wants approve/decline rates per card type before the board update.",
                context: "scope: feed events · deadline: next week",
                status: .pending,
                priority: .medium,
                createdAt: now.addingTimeInterval(-45 * 60),
                githubIssueNumber: nil,
                githubIssueURL: nil,
                agentRoute: "Alice's AI → Your AI",
                routingReason: "You own the iOS client"
            ),

            // Carol
            DecisionCard(
                id: "seed-carol-tokens",
                recipientUserID: DemoUser.carol.user.id,
                senderUserID: DemoUser.alice.user.id,
                type: .approval,
                title: "Freeze the flat design tokens?",
                summary: "Alice's AI locked the palette for the Friday demo. Two components still reference legacy colors.",
                context: "scope: buttons, sheets · deadline: Friday demo",
                status: .pending,
                priority: .high,
                createdAt: now.addingTimeInterval(-12 * 60),
                githubIssueNumber: nil,
                githubIssueURL: nil,
                agentRoute: "Alice's AI → Your AI",
                routingReason: "The design system is yours"
            ),
            DecisionCard(
                id: "seed-carol-offline",
                recipientUserID: DemoUser.carol.user.id,
                senderUserID: DemoUser.dana.user.id,
                type: .task,
                title: "Design the offline-mode empty state",
                summary: "Dana's AI flagged that the feed shows nothing when the relay is down. Needs a designed fallback.",
                context: "scope: feed offline state · deadline: next sprint",
                status: .pending,
                priority: .medium,
                createdAt: now.addingTimeInterval(-55 * 60),
                githubIssueNumber: nil,
                githubIssueURL: nil,
                agentRoute: "Dana's AI → Your AI",
                routingReason: "Design gap found in review"
            ),

            // Dana
            DecisionCard(
                id: "seed-dana-merge",
                recipientUserID: DemoUser.dana.user.id,
                senderUserID: DemoUser.bob.user.id,
                type: .approval,
                title: "Merge the auth hotfix to main?",
                summary: "Bob's AI verified the fix on staging — p95 back to baseline. One approval left to merge.",
                context: "metric: p95 back to baseline · action: merge PR #214 · deadline: today",
                status: .pending,
                priority: .urgent,
                createdAt: now.addingTimeInterval(-4 * 60),
                githubIssueNumber: nil,
                githubIssueURL: nil,
                agentRoute: "Bob's AI → Your AI",
                routingReason: "You review protected branches"
            ),
            DecisionCard(
                id: "seed-dana-headcount",
                recipientUserID: DemoUser.dana.user.id,
                senderUserID: DemoUser.alice.user.id,
                type: .approval,
                title: "One more iOS engineer for Q3?",
                summary: "Alice's AI packaged the case: feed roadmap needs 1 more engineer or the analytics work slips a quarter.",
                context: "scope: Q3 roadmap · action: approve headcount · deadline: planning Monday",
                status: .pending,
                priority: .medium,
                createdAt: now.addingTimeInterval(-90 * 60),
                githubIssueNumber: nil,
                githubIssueURL: nil,
                agentRoute: "Alice's AI → Your AI",
                routingReason: "Hiring approvals route to you"
            )
        ]
    }

    static func user(for id: String) -> User? {
        DemoUser.allCases.map(\.user).first { $0.id == id }
    }

    static func userName(for userID: String) -> String {
        user(for: userID)?.name ?? userID
    }

    static func agentName(for userID: String) -> String {
        "\(userName(for: userID))'s AI"
    }
}
