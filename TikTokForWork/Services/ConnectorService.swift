import Foundation

struct Connector: Identifiable, Decodable, Equatable {
    let id: String
    let label: String
    let status: String

    var isConnected: Bool { status == "active" }
}

/// Pulls new work in from connected apps. A connector being down must never
/// break the feed, so sync failures are swallowed on purpose. Connect and list
/// surface their errors, because the user is looking right at them.
enum ConnectorService {
    private struct ConnectorList: Decodable { let connectors: [Connector] }
    private struct ConnectLink: Decodable { let redirectUrl: String }

    static func list(backendBaseURL: URL) async throws -> [Connector] {
        guard let token = SessionStore.sessionToken,
              let url = URL(string: "connectors", relativeTo: backendBaseURL) else { return [] }
        var request = URLRequest(url: url)
        request.timeoutInterval = 20
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        let (data, _) = try await URLSession.shared.data(for: request)
        return try JSONDecoder().decode(ConnectorList.self, from: data).connectors
    }

    static func connectURL(for id: String, backendBaseURL: URL) async throws -> URL {
        guard let token = SessionStore.sessionToken,
              let url = URL(string: "connectors/\(id)/connect", relativeTo: backendBaseURL) else {
            throw URLError(.badURL)
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        let (data, _) = try await URLSession.shared.data(for: request)
        let link = try JSONDecoder().decode(ConnectLink.self, from: data)
        guard let redirect = URL(string: link.redirectUrl) else { throw URLError(.badServerResponse) }
        return redirect
    }

    @discardableResult
    static func syncAll(orgId: String, userId: String, readerLanguage: String, backendBaseURL: URL) async -> Int {
        guard let token = SessionStore.sessionToken,
              let url = URL(string: "connectors/sync", relativeTo: backendBaseURL) else { return 0 }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 60
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "orgId": orgId, "userId": userId, "readerLanguage": readerLanguage,
        ])
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let results = json["results"] as? [[String: Any]] else { return 0 }
        return results.reduce(0) { $0 + (($1["created"] as? Int) ?? 0) }
    }
}
