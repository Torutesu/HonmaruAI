import Foundation

enum HistoryError: LocalizedError {
    case notSignedIn
    case forbidden
    case server(Int)

    var errorDescription: String? {
        switch self {
        case .notSignedIn: String(localized: "Sign in with GitHub to see your team's history.")
        case .forbidden: String(localized: "You are not a member of this repository.")
        case .server(let code): String(localized: "History request failed (\(code)).")
        }
    }
}

/// Reads the org's activity log. The backend gates this by membership, so the
/// errors below are the ones a normal user can actually hit.
enum HistoryService {
    private struct Envelope: Decodable { let events: [CardEvent] }

    static func fetch(owner: String, repo: String, backendBaseURL: URL, limit: Int = 50) async throws -> [CardEvent] {
        guard let token = SessionStore.sessionToken else { throw HistoryError.notSignedIn }
        guard let url = URL(string: "orgs/\(owner)/\(repo)/events?limit=\(limit)", relativeTo: backendBaseURL) else {
            throw HistoryError.server(0)
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        request.setValue(token, forHTTPHeaderField: "x-session-token")

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw HistoryError.server(0) }
        switch http.statusCode {
        case 200: return try JSONDecoder().decode(Envelope.self, from: data).events
        case 401: throw HistoryError.notSignedIn
        case 403: throw HistoryError.forbidden
        default: throw HistoryError.server(http.statusCode)
        }
    }
}
