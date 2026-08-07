import Foundation

// Live org roster, fed by the server's `welcome` frame and later member
// events. Replaces the hardcoded demo org as the source of truth for
// names, delegation candidates, and the org graph view.
@MainActor
final class OrgDirectory: ObservableObject {
    static let shared = OrgDirectory()

    @Published private(set) var members: [User] = []
    @Published private(set) var teams: [ProtocolTeam] = []
    @Published private(set) var edges: [ProtocolEdge] = []

    func apply(members: [ProtocolMember], teams: [ProtocolTeam], edges: [ProtocolEdge]) {
        self.members = members.map { member in
            User(
                id: member.userId,
                name: member.name,
                role: member.title,
                teamID: member.teamId,
                githubUsername: member.githubUsername
            )
        }
        self.teams = teams
        self.edges = edges
    }

    func upsert(member: ProtocolMember) {
        var updated = members.filter { $0.id != member.userId }
        updated.append(
            User(
                id: member.userId,
                name: member.name,
                role: member.title,
                teamID: member.teamId,
                githubUsername: member.githubUsername
            )
        )
        members = updated
    }

    func reset() {
        members = []
        teams = []
        edges = []
    }

    func user(for id: String) -> User? {
        members.first { $0.id == id }
    }

    func name(for id: String) -> String {
        user(for: id)?.name ?? "Teammate"
    }

    var graph: OrganizationGraph {
        var nodes: [OrgNode] = members.map { member in
            OrgNode(id: member.id, kind: .person, label: "\(member.name) · \(member.role)")
        }
        nodes.append(contentsOf: members.map { member in
            OrgNode(id: "agent-\(member.id)", kind: .agent, label: "\(member.name)'s AI")
        })
        nodes.append(contentsOf: teams.map { team in
            OrgNode(id: team.id, kind: .team, label: team.name)
        })

        var graphEdges: [OrgEdge] = edges.compactMap { edge in
            guard let kind = OrgEdgeKind(rawValue: edge.kind) else { return nil }
            return OrgEdge(id: edge.id, fromID: edge.fromId, toID: edge.toId, kind: kind)
        }
        graphEdges.append(contentsOf: members.map { member in
            OrgEdge(
                id: "agent-edge-\(member.id)",
                fromID: "agent-\(member.id)",
                toID: member.id,
                kind: .assignedTo
            )
        })
        return OrganizationGraph(nodes: nodes, edges: graphEdges)
    }
}

// Wire DTOs matching backend/packages/protocol entities.
struct ProtocolMember: Codable, Hashable {
    let userId: String
    let name: String
    let title: String
    let isAdmin: Bool
    let teamId: String?
    let githubUsername: String?
}

struct ProtocolTeam: Codable, Hashable {
    let id: String
    let orgId: String
    let name: String
}

struct ProtocolEdge: Codable, Hashable {
    let id: String
    let orgId: String
    let kind: String
    let fromId: String
    let toId: String
}

struct ProtocolOrg: Codable, Hashable {
    let id: String
    let name: String
}

// Legacy shim: views still reference DemoData for names and the org graph.
// It now proxies the live directory.
@MainActor
enum DemoData {
    static var organization: OrganizationGraph { OrgDirectory.shared.graph }

    static func user(for id: String) -> User? {
        OrgDirectory.shared.user(for: id)
    }

    static func userName(for userID: String) -> String {
        OrgDirectory.shared.name(for: userID)
    }

    static func agentName(for userID: String) -> String {
        "\(userName(for: userID))'s AI"
    }
}
