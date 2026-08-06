import Foundation

struct User: Identifiable, Codable, Hashable {
    let id: String
    var name: String
    var role: String
    var teamID: String?
    var githubUsername: String?
    var managerID: String?

    var agentID: String { "agent-\(id)" }
    var agentName: String { "\(name)'s AI" }

    init(
        id: String,
        name: String,
        role: String,
        teamID: String? = nil,
        githubUsername: String? = nil,
        managerID: String? = nil
    ) {
        self.id = id
        self.name = name
        self.role = role
        self.teamID = teamID
        self.githubUsername = githubUsername
        self.managerID = managerID
    }
}
