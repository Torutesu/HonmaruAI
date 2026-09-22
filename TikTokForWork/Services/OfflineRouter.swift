import Foundation

/// Preserves the author's words as an editable manual draft. Recipient selection
/// is explicit; an offline fallback never invents people from keyword matches.
enum OfflineRouter {
    // Retain the graph-based API for existing callers. The new composer uses
    // the explicit-recipient overload below and never chooses on the user's behalf.
    /// The member's display name is the label's first half — labels arrive as
    /// "Name · role". Role words widen the match a little beyond a name.
    private static let roleWords: [String: [String]] = [
        "designer": ["designer", "design", "デザイナー"],
        "engineer": ["engineer", "developer", "エンジニア"],
        "admin": ["admin", "owner"],
        "triager": ["triager", "triage"],
        "maintainer": ["maintainer"],
    ]

    /// `mentions` in worker/src/routing.js: ASCII words match on word
    /// boundaries so "dev" does not fire on "device"; anything else matches as
    /// a substring, because \b is meaningless in Japanese. One-character terms
    /// are refused — 健 is inside half the words in the language.
    private static func mentions(_ lower: String, _ term: String) -> Bool {
        let word = term.trimmingCharacters(in: .whitespaces).lowercased()
        guard word.count >= 2 else { return false }
        if word.range(of: #"^[\x00-\x7F]+$"#, options: .regularExpression) != nil {
            let escaped = NSRegularExpression.escapedPattern(for: word)
            return lower.range(of: #"\b"# + escaped + #"\b"#, options: [.regularExpression, .caseInsensitive]) != nil
        }
        return lower.contains(word)
    }

    private static func displayName(of node: OrgNode) -> String {
        String(node.label.split(separator: "·").first ?? "").trimmingCharacters(in: .whitespaces)
    }

    private static func role(of node: OrgNode) -> String {
        let parts = node.label.split(separator: "·")
        return parts.count > 1 ? String(parts[1]).trimmingCharacters(in: .whitespaces).lowercased() : "member"
    }

    static func draft(
        text: String,
        sender: User,
        organization: OrganizationGraph,
        priority: CardPriority
    ) -> InstructionDraft {
        let lower = text.lowercased()
        let members = organization.nodes.filter { $0.kind == .person && $0.id != sender.id }

        var recipientID = sender.id
        var reason = String(localized: "This one is yours to decide")

        // A name in the instruction wins: "ask Yui about the logo" is not a
        // design question, it is a message for Yui.
        if let named = members.first(where: { mentions(lower, displayName(of: $0)) }) {
            recipientID = named.id
            reason = String(localized: "Named in your instruction")
        } else if mentions(lower, "manager") || lower.contains("上司") || lower.contains("エスカレ"),
                  let managerID = organization.edges.first(where: { $0.toID == sender.id && $0.kind == .manages })?.fromID {
            recipientID = managerID
            reason = String(localized: "Escalated to your manager")
        } else if let holder = members.first(where: { member in
            let memberRole = role(of: member)
            return mentions(lower, memberRole) || (roleWords[memberRole] ?? []).contains(where: { mentions(lower, $0) })
        }) {
            recipientID = holder.id
            reason = String(localized: "Routed to the \(role(of: holder))")
        } else if let approver = organization.edges.first(where: { edge in
            edge.kind == .canApprove && members.contains(where: { $0.id == edge.fromID })
        }).map(\.fromID), members.contains(where: { $0.id == approver }) {
            // Same default the relay uses: the person holding approval
            // authority, before the card comes back to you.
            recipientID = approver
            reason = String(localized: "Best match for this decision in org graph")
        }

        let type: CardType
        if lower.contains("承認") || lower.contains("approve") {
            type = .approval
        } else if lower.contains("お願い") || lower.contains("頼") || lower.contains("delegate") {
            type = .delegation
        } else {
            type = .task
        }

        // The instruction is shown as written. Paraphrasing without a model
        // would only invent detail, and a first line of your own words is
        // clearer than a bad summary.
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let title = trimmed.count > 28 ? String(trimmed.prefix(28)) + "…" : trimmed

        return InstructionDraft(
            id: UUID().uuidString,
            sourceText: text,
            recipientUserID: recipientID,
            cardType: type,
            title: title,
            summary: trimmed,
            context: String(localized: "action: drafted locally · scope: offline"),
            priority: priority,
            agentRoute: String(localized: "\(sender.name) → \(DisplayName.of(recipientID, in: organization))"),
            routingReason: reason,
            labels: [],
            toolCalls: []
        )
    }
    static func draft(text: String, sender: User, priority: CardPriority, recipientUserID: String? = nil) -> InstructionDraft {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let recipient = recipientUserID ?? sender.id
        let firstLine = trimmed.split(separator: "\n").first.map(String.init) ?? trimmed
        let title = firstLine.count > 72 ? String(firstLine.prefix(72)) + "…" : firstLine
        return InstructionDraft(
            id: UUID().uuidString, sourceText: text, recipientUserID: recipient,
            cardType: .approval, title: title, summary: trimmed, context: "", priority: priority,
            agentRoute: "", routingReason: String(localized: "Selected by you"), labels: [], toolCalls: []
        )
    }
}
