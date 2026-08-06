import Foundation

/// Thread-safe name lookup so value types (cards, drafts) can render a member's
/// name without reaching into a `@MainActor` observable object.
final class OrgLookup: @unchecked Sendable {
    static let shared = OrgLookup()

    private let lock = NSLock()
    private var namesByID: [String: String] = [:]

    func update(with members: [User]) {
        lock.lock()
        defer { lock.unlock() }
        var names: [String: String] = [:]
        for member in members {
            names[member.id] = member.name
        }
        namesByID = names
    }

    func name(for userID: String) -> String {
        lock.lock()
        defer { lock.unlock() }
        return namesByID[userID] ?? userID
    }

    func agentName(for userID: String) -> String {
        "\(name(for: userID))'s AI"
    }
}

enum OrgDirectoryError: LocalizedError {
    case emptyName
    case duplicateName(String)
    case identityRequired
    case serverError(String)

    var errorDescription: String? {
        switch self {
        case .emptyName: "Enter a name."
        case .duplicateName(let name): "\(name) is already in the organization."
        case .identityRequired: "Pick who you are in the organization."
        case .serverError(let message): message
        }
    }
}

private struct MembersResponse: Decodable {
    let members: [User]
}

private struct AddMemberRequest: Encodable {
    let name: String
    let role: String
    let githubUsername: String?
    let managerID: String?
}

/// The live organization roster. Seeded with the founding members, kept in sync
/// with the relay so every client sees the same people.
@MainActor
final class OrgDirectory: ObservableObject {
    static let shared = OrgDirectory()

    /// The people the organization starts with. Everyone else is added in-app.
    static let foundingMembers: [User] = [
        User(id: "user-toru", name: "Toru", role: "CEO"),
        User(id: "user-gota", name: "Gota", role: "PM", managerID: "user-toru")
    ]

    @Published private(set) var members: [User]

    private var backendBaseURL: URL?

    init(members: [User] = OrgDirectory.foundingMembers) {
        self.members = members
        OrgLookup.shared.update(with: members)
    }

    var graph: OrganizationGraph {
        OrganizationGraph.build(from: members)
    }

    func member(for userID: String) -> User? {
        members.first { $0.id == userID }
    }

    func name(for userID: String) -> String {
        member(for: userID)?.name ?? userID
    }

    func candidates(excluding userID: String) -> [User] {
        members.filter { $0.id != userID }
    }

    func configure(backendBaseURL: URL?) {
        self.backendBaseURL = backendBaseURL
    }

    /// Replaces the roster with the relay's copy. The relay is the source of truth.
    func apply(_ members: [User]) {
        guard !members.isEmpty else { return }
        self.members = members
        OrgLookup.shared.update(with: members)
    }

    func refresh() async {
        guard let url = endpoint() else { return }
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let http = response as? HTTPURLResponse,
                  (200...299).contains(http.statusCode) else { return }
            let decoded = try JSONDecoder().decode(MembersResponse.self, from: data)
            apply(decoded.members)
        } catch {
            // Keep the local roster; the relay may not be running yet.
        }
    }

    @discardableResult
    func addMember(
        name: String,
        role: String,
        managerID: String?,
        githubUsername: String?
    ) async throws -> User {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedRole = role.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedGitHub = githubUsername?.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !trimmedName.isEmpty else { throw OrgDirectoryError.emptyName }
        guard !members.contains(where: { $0.name.lowercased() == trimmedName.lowercased() }) else {
            throw OrgDirectoryError.duplicateName(trimmedName)
        }

        let request = AddMemberRequest(
            name: trimmedName,
            role: trimmedRole.isEmpty ? "Member" : trimmedRole,
            githubUsername: trimmedGitHub?.isEmpty == false ? trimmedGitHub : nil,
            managerID: managerID
        )

        if let url = endpoint() {
            let member = try await postMember(request, to: url)
            if !members.contains(where: { $0.id == member.id }) {
                apply(members + [member])
            }
            return member
        }

        // No relay reachable — add locally so the org is still usable offline.
        let member = User(
            id: localID(for: trimmedName),
            name: trimmedName,
            role: request.role,
            githubUsername: request.githubUsername,
            managerID: request.managerID
        )
        apply(members + [member])
        return member
    }

    private func postMember(_ body: AddMemberRequest, to url: URL) async throws -> User {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw OrgDirectoryError.serverError("Could not reach the relay server.")
        }

        guard (200...299).contains(http.statusCode) else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["message"] as? String
            throw OrgDirectoryError.serverError(message ?? "Could not add member.")
        }

        struct AddMemberResponse: Decodable {
            let member: User
            let members: [User]
        }

        let decoded = try JSONDecoder().decode(AddMemberResponse.self, from: data)
        apply(decoded.members)
        return decoded.member
    }

    private func endpoint() -> URL? {
        guard let backendBaseURL else { return nil }
        return URL(string: "/org/members", relativeTo: backendBaseURL)
    }

    private func localID(for name: String) -> String {
        let slug = name
            .lowercased()
            .map { $0.isLetter || $0.isNumber ? String($0) : "-" }
            .joined()
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        let base = slug.isEmpty ? "member" : slug

        var candidate = "user-\(base)"
        var suffix = 2
        while members.contains(where: { $0.id == candidate }) {
            candidate = "user-\(base)-\(suffix)"
            suffix += 1
        }
        return candidate
    }
}
