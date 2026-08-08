import Foundation

/// The demo is a one-person business, because that is who this has to work for
/// first. Toru runs it; the other identities exist so both ends of a decision
/// can be seen on one phone.
///
/// Work reaches him from two directions, and the product's claim is that they
/// should feel the same: his own agents, which draft and ask, and the outside
/// people he actually owes things to.
enum DemoUser: String, CaseIterable, Identifiable {
    /// The solopreneur. Everything else routes to him.
    case toru
    /// Client — the person on the other side of the invoice.
    case tanaka
    /// Contractor — a designer he sublets work to.
    case yui
    /// Offshore engineer who writes in English. He never switches to Japanese,
    /// and the reader never switches to English: the card is where they meet.
    case alex

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .toru:   "Toru"
        case .tanaka: "田中"
        case .yui:    "結衣"
        case .alex:   "Alex"
        }
    }

    var subtitle: String {
        switch self {
        case .toru:   String(localized: "You · Honmaru")
        case .tanaka: String(localized: "Client · North Inc.")
        case .yui:    String(localized: "Contractor · Design")
        case .alex:   String(localized: "Engineer · English")
        }
    }

    var user: User {
        switch self {
        case .toru:
            User(id: "user-toru", name: "Toru",
                 role: String(localized: "Solo founder"), teamID: "biz-honmaru",
                 githubUsername: "torutano")
        case .tanaka:
            User(id: "user-tanaka", name: "田中",
                 role: String(localized: "Client · North Inc."), teamID: "biz-north",
                 githubUsername: nil)
        case .yui:
            User(id: "user-yui", name: "結衣",
                 role: String(localized: "Contract designer"), teamID: "biz-honmaru",
                 githubUsername: nil)
        case .alex:
            User(id: "user-alex", name: "Alex",
                 role: String(localized: "Contract engineer"), teamID: "biz-honmaru",
                 githubUsername: "alexdev")
        }
    }
}

/// The agents Toru runs. They are senders, not switchable identities — you never
/// log in as your own accountant.
enum DemoAgent: String, CaseIterable {
    case accounting = "agent-accounting"
    case sales      = "agent-sales"
    case social     = "agent-social"
    case research   = "agent-research"

    var displayName: String {
        switch self {
        case .accounting: String(localized: "Accounting AI")
        case .sales:      String(localized: "Sales AI")
        case .social:     String(localized: "Social AI")
        case .research:   String(localized: "Research AI")
        }
    }
}

enum DemoData {
    static let teamUserIDs = DemoUser.allCases.map(\.user.id)

    static let organization = OrganizationGraph(
        nodes: [
            OrgNode(id: "user-toru", kind: .person, label: String(localized: "Toru · You")),
            OrgNode(id: "user-tanaka", kind: .person, label: String(localized: "Tanaka · Client")),
            OrgNode(id: "user-yui", kind: .person, label: String(localized: "Yui · Designer")),
            OrgNode(id: "user-alex", kind: .person, label: String(localized: "Alex · Engineer")),
            OrgNode(id: "agent-accounting", kind: .agent, label: String(localized: "Accounting AI")),
            OrgNode(id: "agent-sales", kind: .agent, label: String(localized: "Sales AI")),
            OrgNode(id: "agent-social", kind: .agent, label: String(localized: "Social AI")),
            OrgNode(id: "agent-research", kind: .agent, label: String(localized: "Research AI")),
            OrgNode(id: "biz-honmaru", kind: .team, label: String(localized: "Honmaru")),
            OrgNode(id: "biz-north", kind: .team, label: String(localized: "North Inc.")),
            OrgNode(id: "project-northsite", kind: .project, label: String(localized: "North Inc. site rebuild")),
        ],
        edges: [
            OrgEdge(id: "e1", fromID: "user-toru", toID: "biz-honmaru", kind: .memberOf),
            OrgEdge(id: "e2", fromID: "user-yui", toID: "biz-honmaru", kind: .memberOf),
            OrgEdge(id: "e3", fromID: "user-tanaka", toID: "biz-north", kind: .memberOf),
            // One person holds every approval. That is the shape of the problem.
            OrgEdge(id: "e4", fromID: "user-toru", toID: "project-northsite", kind: .canApprove),
            OrgEdge(id: "e5", fromID: "user-toru", toID: "user-yui", kind: .manages),
            OrgEdge(id: "e10", fromID: "user-toru", toID: "user-alex", kind: .manages),
            OrgEdge(id: "e6", fromID: "agent-accounting", toID: "user-toru", kind: .assignedTo),
            OrgEdge(id: "e7", fromID: "agent-sales", toID: "user-toru", kind: .assignedTo),
            OrgEdge(id: "e8", fromID: "agent-social", toID: "user-toru", kind: .assignedTo),
            OrgEdge(id: "e9", fromID: "agent-research", toID: "user-toru", kind: .assignedTo),
        ]
    )

    /// What the agents have already triaged by the time he opens the app. Each
    /// card is something a one-person business genuinely has to decide today.
    static func seedCards(now: Date = .now) -> [DecisionCard] {
        let toru = DemoUser.toru.user.id

        return [
            DecisionCard(
                id: "seed-invoice",
                recipientUserID: toru,
                senderUserID: DemoAgent.accounting.rawValue,
                type: .approval,
                title: String(localized: "Send the ¥180,000 invoice to North Inc.?"),
                summary: String(localized: "Accounting AI matched the delivered pages against the estimate and drafted the invoice. Payment terms are end of next month."),
                context: String(localized: "amount: ¥180,000 · deadline: today · action: approve to send"),
                status: .pending,
                priority: .urgent,
                createdAt: now.addingTimeInterval(-8 * 60),
                githubIssueNumber: nil,
                githubIssueURL: nil,
                agentRoute: String(localized: "Accounting AI → You"),
                routingReason: String(localized: "Only you can send an invoice"),
                sourceApp: "freee",
                sourceDetail: "請求書ドラフト"
            ),
            DecisionCard(
                id: "seed-quote",
                recipientUserID: toru,
                senderUserID: DemoAgent.sales.rawValue,
                type: .approval,
                title: String(localized: "Two quote requests — which one first?"),
                summary: String(localized: "Sales AI ranked them: the ¥500,000 job starts in three weeks, the ¥120,000 job wants an answer today. You cannot take both this month."),
                context: String(localized: "amount: ¥500,000 / ¥120,000 · deadline: today · action: pick one"),
                status: .pending,
                priority: .high,
                createdAt: now.addingTimeInterval(-35 * 60),
                githubIssueNumber: nil,
                githubIssueURL: nil,
                agentRoute: String(localized: "Sales AI → You"),
                routingReason: String(localized: "Taking work is yours to decide"),
                sourceApp: "Gmail",
                sourceDetail: "見積もり依頼 2件"
            ),
            DecisionCard(
                id: "seed-revision",
                recipientUserID: toru,
                senderUserID: DemoUser.tanaka.user.id,
                type: .task,
                title: String(localized: "North Inc. wants the hero section redone"),
                summary: String(localized: "Tanaka asked for a different hero image. It is outside the agreed scope, so it is either a change order or goodwill."),
                context: String(localized: "scope: outside estimate · deadline: Friday · action: change order or absorb"),
                status: .pending,
                priority: .high,
                createdAt: now.addingTimeInterval(-2 * 60 * 60),
                githubIssueNumber: nil,
                githubIssueURL: nil,
                agentRoute: String(localized: "Tanaka → Your AI"),
                routingReason: String(localized: "You own the North Inc. contract"),
                sourceApp: "Slack",
                sourceDetail: "#north-inc"
            ),
            DecisionCard(
                id: "seed-logo",
                recipientUserID: toru,
                senderUserID: DemoUser.yui.user.id,
                type: .approval,
                title: String(localized: "Three logo directions — pick one to finish"),
                summary: String(localized: "Yui will not start the final artwork until one is chosen. Her slot closes at the end of the week."),
                context: String(localized: "scope: logo finalisation · deadline: end of week · action: pick a direction"),
                status: .pending,
                priority: .medium,
                createdAt: now.addingTimeInterval(-5 * 60 * 60),
                githubIssueNumber: nil,
                githubIssueURL: nil,
                agentRoute: String(localized: "Yui → Your AI"),
                routingReason: String(localized: "You approve contractor work"),
                sourceApp: "Notion",
                sourceDetail: "ロゴ案 v3"
            ),
            DecisionCard(
                id: "seed-pricing",
                recipientUserID: toru,
                senderUserID: DemoAgent.research.rawValue,
                type: .notification,
                title: String(localized: "A competitor raised prices 20%"),
                summary: String(localized: "Research AI has been watching three competitors. Two now sit above your rate. Raising yours would put you mid-market rather than cheapest."),
                context: String(localized: "metric: competitor +20% · scope: your rate card · action: revise pricing"),
                status: .pending,
                priority: .medium,
                createdAt: now.addingTimeInterval(-9 * 60 * 60),
                githubIssueNumber: nil,
                githubIssueURL: nil,
                agentRoute: String(localized: "Research AI → You"),
                routingReason: String(localized: "Pricing is yours alone"),
                sourceApp: "Notion",
                sourceDetail: "競合ウォッチ"
            ),
            DecisionCard(
                id: "seed-social",
                recipientUserID: toru,
                senderUserID: DemoAgent.social.rawValue,
                type: .approval,
                title: String(localized: "Publish this week's three posts?"),
                summary: String(localized: "Social AI drafted them from the North Inc. work. Nothing identifies the client until you say it can."),
                context: String(localized: "scope: 3 posts · deadline: Monday · action: approve to publish"),
                status: .pending,
                priority: .low,
                createdAt: now.addingTimeInterval(-26 * 60 * 60),
                githubIssueNumber: nil,
                githubIssueURL: nil,
                agentRoute: String(localized: "Social AI → You"),
                routingReason: String(localized: "Anything public goes through you"),
                sourceApp: "Notion",
                sourceDetail: "今週の投稿"
            ),

            DecisionCard(
                id: "seed-tax",
                recipientUserID: toru,
                senderUserID: DemoAgent.accounting.rawValue,
                type: .approval,
                title: String(localized: "Confirm this quarter's tax filing?"),
                summary: String(localized: "Accounting AI reconciled every receipt and found two it cannot categorise. Filing closes in three days."),
                context: String(localized: "amount: ¥62,000 unclear · deadline: 3 days · action: confirm or recategorise"),
                status: .pending,
                priority: .urgent,
                createdAt: now.addingTimeInterval(-18 * 60),
                githubIssueNumber: nil,
                githubIssueURL: nil,
                agentRoute: String(localized: "Accounting AI → You"),
                routingReason: String(localized: "Filing is in your name"),
                sourceApp: "freee",
                sourceDetail: "確定申告 2026"
            ),
            DecisionCard(
                id: "seed-lead",
                recipientUserID: toru,
                senderUserID: DemoAgent.sales.rawValue,
                type: .approval,
                title: String(localized: "A lead went quiet for ten days"),
                summary: String(localized: "Sales AI drafted a follow-up that does not sound desperate. Send it, or let this one go."),
                context: String(localized: "scope: ¥300,000 lead · deadline: today · action: send or drop"),
                status: .pending,
                priority: .high,
                createdAt: now.addingTimeInterval(-52 * 60),
                githubIssueNumber: nil,
                githubIssueURL: nil,
                agentRoute: String(localized: "Sales AI → You"),
                routingReason: String(localized: "Only you can decide to chase"),
                sourceApp: "Gmail",
                sourceDetail: "問い合わせフォーム"
            ),
            DecisionCard(
                id: "seed-contract",
                recipientUserID: toru,
                senderUserID: DemoUser.tanaka.user.id,
                type: .approval,
                title: String(localized: "North Inc. wants to extend three months"),
                summary: String(localized: "Tanaka asked to continue past the current contract at the same rate. Your rate has since gone up."),
                context: String(localized: "amount: same rate · scope: 3 months · action: accept or renegotiate"),
                status: .pending,
                priority: .high,
                createdAt: now.addingTimeInterval(-95 * 60),
                githubIssueNumber: nil,
                githubIssueURL: nil,
                agentRoute: String(localized: "Tanaka → Your AI"),
                routingReason: String(localized: "Your contract, your rate"),
                sourceApp: "Gmail",
                sourceDetail: "契約延長のご相談"
            ),
            DecisionCard(
                id: "seed-subscription",
                recipientUserID: toru,
                senderUserID: DemoAgent.accounting.rawValue,
                type: .notification,
                title: String(localized: "Three tools renew this week"),
                summary: String(localized: "Accounting AI found ¥18,400 of subscriptions renewing, two of which you have not opened in 60 days."),
                context: String(localized: "amount: ¥18,400 · deadline: this week · action: cancel or keep"),
                status: .pending,
                priority: .medium,
                createdAt: now.addingTimeInterval(-180 * 60),
                githubIssueNumber: nil,
                githubIssueURL: nil,
                agentRoute: String(localized: "Accounting AI → You"),
                routingReason: String(localized: "Spending is yours to approve"),
                sourceApp: "freee",
                sourceDetail: "定期支払い"
            ),
            DecisionCard(
                id: "seed-testimonial",
                recipientUserID: toru,
                senderUserID: DemoAgent.social.rawValue,
                type: .task,
                title: String(localized: "Ask North Inc. for a testimonial?"),
                summary: String(localized: "Social AI noticed the project shipped well. The window for asking closes as the work fades."),
                context: String(localized: "scope: 1 request · deadline: this month · action: approve to ask"),
                status: .pending,
                priority: .low,
                createdAt: now.addingTimeInterval(-300 * 60),
                githubIssueNumber: nil,
                githubIssueURL: nil,
                agentRoute: String(localized: "Social AI → You"),
                routingReason: String(localized: "Client relationships are yours"),
                sourceApp: "Slack",
                sourceDetail: "#north-inc"
            ),
            DecisionCard(
                id: "seed-scope",
                recipientUserID: toru,
                senderUserID: DemoUser.yui.user.id,
                type: .task,
                title: String(localized: "Yui is two days from finishing early"),
                summary: String(localized: "She can take more work this week or stop. Nothing is queued behind the current job."),
                context: String(localized: "scope: 2 spare days · deadline: Wednesday · action: assign or leave"),
                status: .pending,
                priority: .medium,
                createdAt: now.addingTimeInterval(-420 * 60),
                githubIssueNumber: nil,
                githubIssueURL: nil,
                agentRoute: String(localized: "Yui → Your AI"),
                routingReason: String(localized: "You decide what she works on"),
                sourceApp: "Google Calendar",
                sourceDetail: "結衣 稼働枠"
            ),
            DecisionCard(
                id: "seed-outage",
                recipientUserID: toru,
                senderUserID: DemoAgent.research.rawValue,
                type: .notification,
                title: String(localized: "Your host had an outage last night"),
                summary: String(localized: "Research AI saw four hours of downtime on the North Inc. site. Tanaka has not mentioned it."),
                context: String(localized: "metric: 4h downtime · action: tell the client or wait · deadline: today"),
                status: .pending,
                priority: .high,
                createdAt: now.addingTimeInterval(-520 * 60),
                githubIssueNumber: nil,
                githubIssueURL: nil,
                agentRoute: String(localized: "Research AI → You"),
                routingReason: String(localized: "Bad news travels better from you"),
                sourceApp: "Slack",
                sourceDetail: "#alerts"
            ),
            DecisionCard(
                id: "seed-invoice-late",
                recipientUserID: toru,
                senderUserID: DemoAgent.accounting.rawValue,
                type: .approval,
                title: String(localized: "An invoice is 14 days overdue"),
                summary: String(localized: "Accounting AI drafted a reminder. The client is one you want to keep, so the wording matters."),
                context: String(localized: "amount: ¥95,000 · deadline: overdue 14 days · action: send the reminder"),
                status: .pending,
                priority: .urgent,
                createdAt: now.addingTimeInterval(-640 * 60),
                githubIssueNumber: nil,
                githubIssueURL: nil,
                agentRoute: String(localized: "Accounting AI → You"),
                routingReason: String(localized: "Chasing money is yours alone"),
                sourceApp: "freee",
                sourceDetail: "入金状況"
            ),

            // Written in English, read in Japanese. The reader never has to
            // switch languages to decide, and the original is one tap away.
            DecisionCard(
                id: "seed-alex-deploy",
                recipientUserID: toru,
                senderUserID: DemoUser.alex.user.id,
                type: .approval,
                title: String(localized: "Deploy the North Inc. site tonight?"),
                summary: String(localized: "Alex finished the rebuild and wants to deploy during the client's night. If it waits, the next window is Monday."),
                context: String(localized: "deadline: tonight · scope: North Inc. site · action: approve to deploy"),
                status: .pending,
                priority: .urgent,
                createdAt: now.addingTimeInterval(-14 * 60),
                githubIssueNumber: nil,
                githubIssueURL: nil,
                agentRoute: String(localized: "Alex → Your AI"),
                routingReason: String(localized: "Deploys need your go"),
                sourceApp: "Slack",
                sourceDetail: "DM · Alex",
                originalBody: "Rebuild is done and staging looks clean. I'd like to push to production tonight while their traffic is low — otherwise the next safe window is Monday. Need your go by 22:00 my time.",
                originalLanguage: "en"
            ),
            DecisionCard(
                id: "seed-alex-scope",
                recipientUserID: toru,
                senderUserID: DemoUser.alex.user.id,
                type: .task,
                title: String(localized: "Alex found undocumented work"),
                summary: String(localized: "The old site has a booking form nobody mentioned. Rebuilding it is roughly three extra days."),
                context: String(localized: "scope: booking form · deadline: this week · action: bill it or drop it"),
                status: .pending,
                priority: .high,
                createdAt: now.addingTimeInterval(-3 * 60 * 60),
                githubIssueNumber: nil,
                githubIssueURL: nil,
                agentRoute: String(localized: "Alex → Your AI"),
                routingReason: String(localized: "Scope changes are yours"),
                sourceApp: "Slack",
                sourceDetail: "DM · Alex",
                originalBody: "Heads up — there's a booking form on the old site that wasn't in the spec. It talks to some legacy endpoint. Rebuilding it properly is ~3 days. Do you want me to quote it, or should we leave it out?",
                originalLanguage: "en"
            ),

            // The other side of the same work, so switching identity shows a
            // decision arriving rather than an empty feed.
            DecisionCard(
                id: "seed-tanaka-estimate",
                recipientUserID: DemoUser.tanaka.user.id,
                senderUserID: DemoUser.toru.user.id,
                type: .approval,
                title: String(localized: "Approve the change order for the hero section?"),
                summary: String(localized: "Toru's AI priced the extra work at ¥40,000 and pushed delivery back two days."),
                context: String(localized: "amount: ¥40,000 · deadline: Friday · action: approve the change order"),
                status: .pending,
                priority: .high,
                createdAt: now.addingTimeInterval(-30 * 60),
                githubIssueNumber: nil,
                githubIssueURL: nil,
                agentRoute: String(localized: "Toru's AI → Your AI"),
                routingReason: String(localized: "Budget approval is yours"),
                sourceApp: "Gmail",
                sourceDetail: "追加見積もり"
            ),
            DecisionCard(
                id: "seed-yui-brief",
                recipientUserID: DemoUser.yui.user.id,
                senderUserID: DemoUser.toru.user.id,
                type: .delegation,
                title: String(localized: "Take the hero image rework"),
                summary: String(localized: "Toru's AI split the change order: you redo the hero, he handles the client."),
                context: String(localized: "scope: hero image · deadline: Thursday · action: start the rework"),
                status: .pending,
                priority: .medium,
                createdAt: now.addingTimeInterval(-25 * 60),
                githubIssueNumber: nil,
                githubIssueURL: nil,
                agentRoute: String(localized: "Toru's AI → Your AI"),
                routingReason: String(localized: "You own the visual work"),
                sourceApp: "Slack",
                sourceDetail: "DM · 結衣"
            ),
        ]
    }

    static func user(for id: String) -> User? {
        DemoUser.allCases.map(\.user).first { $0.id == id }
    }

    /// Senders include agents, which are not switchable users — resolve those
    /// too, or a card from Accounting AI shows a raw id.
    static func userName(for userID: String) -> String {
        if let user = user(for: userID) { return user.name }
        if let agent = DemoAgent(rawValue: userID) { return agent.displayName }
        return userID
    }

    static func agentName(for userID: String) -> String {
        if let agent = DemoAgent(rawValue: userID) { return agent.displayName }
        return "\(userName(for: userID))'s AI"
    }
}
