import Foundation

struct User: Identifiable, Codable, Hashable {
    let id: String
    var name: String
    var role: String
    var teamID: String?
    var githubUsername: String?
    var agentID: String { "agent-\(id)" }
}
