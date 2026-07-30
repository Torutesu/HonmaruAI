import Foundation

@MainActor
final class OrganizationService: ObservableObject {
    @Published private(set) var users: [User] = OrgDirectory.users
    @Published private(set) var organization: OrganizationGraph = OrgDirectory.organization

    private var backendBaseURL: URL?
    private var relayToken: String?

    private struct OrgPayload: Decodable {
        let users: [User]
        let nodes: [OrgNode]
        let edges: [OrgEdge]
    }

    private struct AddMemberResponse: Decodable {
        let user: User
        let organization: OrgPayload
    }

    func attach(webSocketService: WebSocketService) {
        webSocketService.addEventHandler { [weak self] event in
            if case .orgUpdated(let users, let organization) = event {
                self?.apply(users: users, organization: organization)
            }
        }
    }

    func configure(backendBaseURL: URL?, relayToken: String?) async {
        self.backendBaseURL = backendBaseURL
        self.relayToken = relayToken
        await refresh()
    }

    func refresh() async {
        guard let request = makeRequest(path: "/org", method: "GET") else { return }

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                return
            }
            let payload = try JSONDecoder().decode(OrgPayload.self, from: data)
            apply(
                users: payload.users,
                organization: OrganizationGraph(nodes: payload.nodes, edges: payload.edges)
            )
        } catch {
            // Relay unreachable — keep the seeded roster.
        }
    }

    @discardableResult
    func addMember(
        name: String,
        role: String,
        team: String,
        githubUsername: String
    ) async throws -> User {
        guard var request = makeRequest(path: "/org/members", method: "POST") else {
            throw AIServiceError.notConfigured
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "name": name,
            "role": role,
            "team": team,
            "githubUsername": githubUsername,
        ])

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw AIServiceError.invalidResponse
        }
        guard (200...299).contains(http.statusCode) else {
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            let message = json?["message"] as? String
            throw AIServiceError.serverError(message ?? "Could not add member.")
        }

        let decoded = try JSONDecoder().decode(AddMemberResponse.self, from: data)
        apply(
            users: decoded.organization.users,
            organization: OrganizationGraph(
                nodes: decoded.organization.nodes,
                edges: decoded.organization.edges
            )
        )
        return decoded.user
    }

    func userMatching(githubUsername: String?) -> User? {
        guard let githubUsername, !githubUsername.isEmpty else { return nil }
        return users.first { $0.githubUsername?.lowercased() == githubUsername.lowercased() }
    }

    private func apply(users: [User], organization: OrganizationGraph) {
        self.users = users
        self.organization = organization
        OrgDirectory.apply(users: users, organization: organization)
    }

    private func makeRequest(path: String, method: String) -> URLRequest? {
        guard let backendBaseURL, let url = URL(string: path, relativeTo: backendBaseURL) else {
            return nil
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let relayToken, !relayToken.isEmpty {
            request.setValue("Bearer \(relayToken)", forHTTPHeaderField: "Authorization")
        }
        return request
    }
}
