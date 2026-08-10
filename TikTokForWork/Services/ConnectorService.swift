import Foundation

/// Pulls new work in from connected apps. A connector being down must never
/// break the feed, so every failure here is swallowed on purpose.
enum ConnectorService {
    @discardableResult
    static func syncGmail(orgId: String, userId: String, readerLanguage: String, backendBaseURL: URL) async -> Int {
        guard let token = SessionStore.sessionToken,
              let url = URL(string: "connectors/gmail/sync", relativeTo: backendBaseURL) else { return 0 }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "orgId": orgId, "userId": userId, "readerLanguage": readerLanguage,
        ])

        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return 0
        }
        return json["created"] as? Int ?? 0
    }
}
