import Foundation

enum WorkspaceMemberService {
    private struct Response: Decodable { let orgId: String; let members: [WorkspaceMember] }

    static func fetch(orgID: String, baseURL: URL, sessionToken: String) async throws -> [WorkspaceMember] {
        guard var components = URLComponents(url: baseURL.appending(path: "members"), resolvingAgainstBaseURL: true) else { throw URLError(.badURL) }
        components.queryItems = [URLQueryItem(name: "orgId", value: orgID)]
        guard let url = components.url else { throw URLError(.badURL) }
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        request.setValue(sessionToken, forHTTPHeaderField: "x-session-token")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        let result = try JSONDecoder().decode(Response.self, from: data)
        guard result.orgId == orgID else { throw URLError(.badServerResponse) }
        return result.members
    }
}
