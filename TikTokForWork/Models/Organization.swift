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

struct OrganizationGraph: Codable {
    var nodes: [OrgNode]
    var edges: [OrgEdge]

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
