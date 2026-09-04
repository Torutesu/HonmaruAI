import Foundation

struct Connector: Identifiable, Decodable, Equatable {
    let id: String
    let label: String
    let status: String

    var isConnected: Bool { status == "active" }
}

struct NotionDatabase: Identifiable, Decodable, Equatable {
    let id: String
    let title: String
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

    /// Where to send mail so it reaches you.
    ///
    /// Email is the one connector you do not authorize — you forward to it. The
    /// address names its owner (`u-<github id>@<domain>`), and until this
    /// existed there was nowhere in the app to find out what yours was, so the
    /// connector could not be used at all. Returns nil where the deployment has
    /// no inbound domain configured, which is most of them.
    static func inboundEmailAddress(backendBaseURL: URL) async -> String? {
        guard let token = SessionStore.sessionToken,
              let url = URL(string: "connectors/email/address", relativeTo: backendBaseURL) else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse, http.statusCode == 200
        else { return nil }
        return try? JSONDecoder().decode(InboundAddress.self, from: data).address
    }

    private struct InboundAddress: Decodable { let address: String }

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

extension ConnectorService {
    private struct DatabaseList: Decodable { let databases: [NotionDatabase] }
    private struct DatabaseConfig: Decodable { let databaseId: String? }

    /// Clears any `notion.database.<token>` value written by the previous build's local
    /// stopgap. The server is the only source of truth now, so a lingering local copy would
    /// only be a second one waiting to drift. Cheap to run every launch.
    static func clearLegacyNotionDatabaseDefaults() {
        for key in UserDefaults.standard.dictionaryRepresentation().keys where key.hasPrefix("notion.database.") {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }

    static func notionDatabases(backendBaseURL: URL) async throws -> [NotionDatabase] {
        guard let token = SessionStore.sessionToken,
              let url = URL(string: "connectors/notion/databases", relativeTo: backendBaseURL) else { return [] }
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(DatabaseList.self, from: data).databases
    }

    /// The user's current choice, read straight from the server so the picker's checkmark
    /// can never drift from what the backend will actually sync. `databaseId` is always
    /// present in the response — `null` when nothing is chosen — so there is one field to
    /// read and no status code to branch on.
    static func notionDatabaseConfig(backendBaseURL: URL) async throws -> String? {
        guard let token = SessionStore.sessionToken,
              let url = URL(string: "connectors/notion/config", relativeTo: backendBaseURL) else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 20
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(DatabaseConfig.self, from: data).databaseId
    }

    static func setNotionDatabase(_ id: String, backendBaseURL: URL) async throws {
        guard let token = SessionStore.sessionToken,
              let url = URL(string: "connectors/notion/config", relativeTo: backendBaseURL) else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.timeoutInterval = 20
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["databaseId": id])
        let (_, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
    }
}
