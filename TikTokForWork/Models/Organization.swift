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
}

struct OrgEdge: Identifiable, Codable, Hashable {
    let id: String
    let fromID: String
    let toID: String
    let kind: OrgEdgeKind
}

/// Groups a member's free-text role into the buckets the AI routes on.
/// Mirrors `ROLE_CATEGORIES` in `server/agentTools.js`.
enum RoleCategory: String, CaseIterable {
    case leadership
    case product
    case engineering
    case design
    case general

    var teamID: String { "team-\(rawValue)" }

    var teamLabel: String {
        switch self {
        case .leadership: "Leadership"
        case .product: "Product"
        case .engineering: "Engineering"
        case .design: "Design"
        case .general: "Team"
        }
    }

    static func infer(from role: String) -> RoleCategory {
        let lower = role.lowercased()

        func contains(_ needles: [String]) -> Bool {
            needles.contains { lower.contains($0) }
        }

        if contains(["design", "ux", "ui", "brand"]) { return .design }
        if contains(["engineer", "developer", "dev", "cto", "sre", "tech lead"]) { return .engineering }
        if contains(["product", "pm", "program manager"]) { return .product }
        if contains(["ceo", "founder", "chief", "head", "vp", "director", "lead"]) { return .leadership }
        return .general
    }
}

struct OrganizationGraph: Codable {
    var nodes: [OrgNode]
    var edges: [OrgEdge]

    /// Derives the graph from the live roster so newly added members appear
    /// without any hand-maintained node/edge list.
    static func build(from members: [User]) -> OrganizationGraph {
        var nodes: [OrgNode] = []
        var edges: [OrgEdge] = []
        var seenTeams: Set<String> = []

        for member in members {
            nodes.append(
                OrgNode(id: member.id, kind: .person, label: "\(member.name) · \(member.role)")
            )
            nodes.append(
                OrgNode(id: member.agentID, kind: .agent, label: member.agentName)
            )
            edges.append(
                OrgEdge(
                    id: "assigned-\(member.id)",
                    fromID: member.agentID,
                    toID: member.id,
                    kind: .assignedTo
                )
            )
        }

        for member in members {
            let category = RoleCategory.infer(from: member.role)
            let teamID = member.teamID ?? category.teamID

            if seenTeams.insert(teamID).inserted {
                let label = member.teamID == nil ? category.teamLabel : teamID
                nodes.append(OrgNode(id: teamID, kind: .team, label: label))
            }

            edges.append(
                OrgEdge(
                    id: "member-\(member.id)-\(teamID)",
                    fromID: member.id,
                    toID: teamID,
                    kind: .memberOf
                )
            )

            if let managerID = member.managerID,
               members.contains(where: { $0.id == managerID }) {
                edges.append(
                    OrgEdge(
                        id: "manages-\(managerID)-\(member.id)",
                        fromID: managerID,
                        toID: member.id,
                        kind: .manages
                    )
                )
            }
        }

        return OrganizationGraph(nodes: nodes, edges: edges)
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

    func routingReason(recipientID: String, senderID: String, namedInInstruction: Bool) -> String {
        if namedInInstruction {
            return "Named in your instruction"
        }
        if let manager = manager(of: senderID), manager.id == recipientID {
            return "You are \(OrgLookup.shared.name(for: senderID))'s manager"
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
