import Foundation

struct ChatChannel: Identifiable, Codable, Hashable {
    let id: String
    let name: String
    var purpose: String
    var createdAt: Date
}

struct ChatMessage: Identifiable, Codable, Hashable {
    enum AuthorKind: String, Codable {
        case user
        case agent
    }

    let id: String
    let channelID: String
    let authorID: String
    let authorKind: AuthorKind
    let authorName: String
    let text: String
    let createdAt: Date
    var toolCalls: [AgentToolCall]?
    var cardID: String?

    var isAgent: Bool { authorKind == .agent }
}
