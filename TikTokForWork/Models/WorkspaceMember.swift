import Foundation

struct WorkspaceMember: Identifiable, Codable, Hashable {
    let id: String
    let name: String
    let role: String
    let avatarUrl: String?
}

enum DemoWorkspace {
    static let id = "demo-workspace"
    static let userID = "guest"
    static var members: [WorkspaceMember] { [
        .init(id: userID, name: String(localized: "You"), role: String(localized: "Product lead"), avatarUrl: nil),
        .init(id: "demo-mika", name: "Mika Tanaka", role: String(localized: "Design"), avatarUrl: nil),
        .init(id: "demo-sarah", name: "Sarah Chen", role: String(localized: "Marketing Manager"), avatarUrl: nil),
        .init(id: "demo-aya", name: "Aya Suzuki", role: String(localized: "Operations"), avatarUrl: nil)
    ] }

    static var organization: OrganizationGraph {
        OrganizationGraph(nodes: members.map { .init(id: $0.id, kind: .person, label: "\($0.name) · \($0.role)") }, edges: [])
    }

    static func cards(now: Date = .now) -> [String: [DecisionCard]] {
        let cards: [DecisionCard] = [
            DecisionCard(id: "demo-launch", recipientUserID: userID, senderUserID: "demo-sarah", type: .approval,
                         title: String(localized: "Approve $1,840 for the onboarding video reshoot"),
                         summary: String(localized: "Reshoot covers the new signup flow. Same crew as June and it lands 15% under this quarter's video budget."),
                         context: String(localized: "This is sample data from the product design. No budget approval or external work is performed in the demo."),
                         status: .pending, priority: .high, createdAt: now.addingTimeInterval(-720),
                         business: String(localized: "Marketing"), sourceApp: "slack", sourceDetail: "#marketing",
                         recommendation: DecisionRecommendation(action: "approve", reason: String(localized: "This request is 15% under this quarter's video budget and consistent with similar requests you've approved in the past.")),
                         requestedBy: CardRequester(name: "Sarah Chen", login: "demo-sarah", role: String(localized: "Marketing Manager"), avatarUrl: nil,
                                                    quote: String(localized: "We need to reshoot the onboarding video to reflect the new signup flow. Current video is causing confusion and drop-off."), sourceUrl: nil)),
            DecisionCard(id: "demo-design", recipientUserID: userID, senderUserID: "demo-mika", type: .revision,
                         title: String(localized: "Confirm the homepage direction"),
                         summary: String(localized: "We have narrowed the design to two directions. Which message should the team lead with?"),
                         context: String(localized: "Option A leads with faster decisions. Option B leads with fewer meetings. A short reply will unblock the final layout."),
                         status: .pending, priority: .high, createdAt: now.addingTimeInterval(-4_800),
                         business: String(localized: "Design"), sourceApp: "slack", sourceDetail: "#website"),
            DecisionCard(id: "demo-checklist", recipientUserID: userID, senderUserID: "demo-aya", type: .task,
                         title: String(localized: "Review the customer handoff checklist"),
                         summary: String(localized: "Check the owner, due date, and support contact before Friday's customer handoff."),
                         context: String(localized: "The account team has filled in the checklist. Mark this complete after your review, or delegate it to the right person."),
                         status: .pending, priority: .medium, createdAt: now.addingTimeInterval(-9_000),
                         business: String(localized: "Operations"), sourceApp: "notion", sourceDetail: "Customer handoff"),
            DecisionCard(id: "demo-sent", recipientUserID: "demo-mika", senderUserID: userID, type: .approval,
                         title: String(localized: "Review the launch announcement"),
                         summary: String(localized: "Please review the announcement copy before it goes to customers."),
                         context: String(localized: "This sample request is waiting for Mika. Sent requests stay here so you can follow the outcome."),
                         status: .pending, priority: .high, createdAt: now.addingTimeInterval(-14_400), business: String(localized: "Marketing")),
            DecisionCard(id: "demo-completed", recipientUserID: userID, senderUserID: "demo-aya", type: .notification,
                         title: String(localized: "The weekly report is ready"),
                         summary: String(localized: "Your team has published this week's customer feedback and product metrics."),
                         context: String(localized: "This sample shows how a completed request remains available with its decision."),
                         status: .completed, priority: .low, createdAt: now.addingTimeInterval(-86_400),
                         decision: Decision(action: "acknowledge", optionId: nil, note: nil, replyText: nil,
                                            actorUserID: userID, decidedAt: now.addingTimeInterval(-82_800)))
        ]
        return Dictionary(grouping: cards, by: \.recipientUserID)
    }
}
