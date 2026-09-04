import Foundation

enum OrgNodeKind: String, Codable {
    case person
    case team
    case agent
    case project
}

enum OrgEdgeKind: String, Codable {
    case manages
    case memberOf
    case assignedTo
    case canApprove
}

struct OrgNode: Identifiable, Codable, Hashable {
    let id: String
    let kind: OrgNodeKind
    var label: String
    /// What this person is responsible for, in their own words.
    ///
    /// The graph used to be the repository's permission list with the words
    /// changed — Admin, Maintainer, Engineer — so "route this to whoever it
    /// belongs to" had nothing to route by. This is the line that says
    /// "budgets and vendor contracts", and it goes to the model with the rest.
    var detail: String?
}

struct OrgEdge: Identifiable, Codable, Hashable {
    let id: String
    let fromID: String
    let toID: String
    let kind: OrgEdgeKind
}

struct OrganizationGraph: Codable {
    var nodes: [OrgNode]
    var edges: [OrgEdge]

    /// The people in this organization, as users a card can be addressed to.
    ///
    /// A person node's label carries "<name> · <role>". This is the one place
    /// that takes it apart — the delegate picker and the draft review sheet had
    /// a copy each, and a card can only be sent to someone who is really here.
    var people: [User] {
        nodes.filter { $0.kind == .person }.map { node in
            let parts = node.label
                .split(separator: "·", maxSplits: 1)
                .map { $0.trimmingCharacters(in: .whitespaces) }
            return User(
                id: node.id,
                name: parts.first ?? node.label,
                role: parts.count > 1 ? parts[1] : String(localized: "Member"),
                teamID: nil,
                githubUsername: node.id
            )
        }
    }

    func manager(of userID: String) -> OrgNode? {
        guard let edge = edges.first(where: { $0.toID == userID && $0.kind == .manages }) else {
            return nil
        }
        return nodes.first { $0.id == edge.fromID }
    }

    func approvalProjects(for userID: String) -> [OrgNode] {
        edges
            .filter { $0.fromID == userID && $0.kind == .canApprove }
            .compactMap { edge in nodes.first { $0.id == edge.toID } }
    }

    /// What this person is responsible for, if they have said.
    func detail(of userID: String) -> String? {
        nodes.first { $0.id == userID && $0.kind == .person }?.detail
    }

    /// Whether this person can sign things off for the team.
    func canApprove(_ userID: String) -> Bool {
        edges.contains { $0.fromID == userID && $0.kind == .canApprove }
    }

    /// Who reports to this person.
    func reports(to userID: String) -> [OrgNode] {
        edges
            .filter { $0.fromID == userID && $0.kind == .manages }
            .compactMap { edge in nodes.first { $0.id == edge.toID } }
    }

    func routingReason(recipientID: String, senderID: String, namedInInstruction: Bool) -> String {
        if namedInInstruction {
            return "Named in your instruction"
        }
        if let manager = manager(of: senderID), manager.id == recipientID {
            return "You are \(DisplayName.of(senderID, in: self))'s manager"
        }
        if let project = approvalProjects(for: recipientID).first {
            return "Approval authority on \(project.label)"
        }
        if recipientID != senderID {
            return "Best match for this decision in org graph"
        }
        return "Routed to you"
    }
}
