import Foundation

/// Your place in the organization: what you do, what you are responsible for,
/// and who you report to.
///
/// GitHub knows who can push to a repository and nothing else. It has no idea
/// who runs design or who owns the client relationship, so neither did the org
/// graph — a person's "role" was their push permission with the word changed,
/// and routing was asked to choose between Admin and Engineer.
///
/// Written by the person it describes. You know your own job, and "X manages
/// me" is a claim that only makes sense in that direction.
struct OrgProfile: Codable, Equatable {
    var title: String?
    var responsibilities: String?
    var managerLogin: String?

    static let empty = OrgProfile(title: nil, responsibilities: nil, managerLogin: nil)

    var isEmpty: Bool {
        [title, responsibilities, managerLogin]
            .allSatisfy { ($0 ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }
}

enum OrgProfileError: LocalizedError {
    case notSignedIn
    case server(String)

    var errorDescription: String? {
        switch self {
        case .notSignedIn: String(localized: "Sign in with GitHub to edit your profile.")
        case .server(let message): message
        }
    }
}

enum OrgProfileService {
    static func load(orgId: String, backendBaseURL: URL) async throws -> OrgProfile {
        let (data, http) = try await send(orgId: orgId, backendBaseURL: backendBaseURL, method: "GET", body: nil)
        guard (200...299).contains(http.statusCode) else {
            throw OrgProfileError.server(message(from: data) ?? String(localized: "Could not load your profile."))
        }
        return try JSONDecoder().decode(OrgProfile.self, from: data)
    }

    static func save(_ profile: OrgProfile, orgId: String, backendBaseURL: URL) async throws {
        let body = try JSONEncoder().encode(profile)
        let (data, http) = try await send(orgId: orgId, backendBaseURL: backendBaseURL, method: "PUT", body: body)
        guard (200...299).contains(http.statusCode) else {
            throw OrgProfileError.server(message(from: data) ?? String(localized: "Could not save your profile."))
        }
    }

    private static func send(
        orgId: String,
        backendBaseURL: URL,
        method: String,
        body: Data?
    ) async throws -> (Data, HTTPURLResponse) {
        let parts = orgId.split(separator: "/")
        guard parts.count == 2, let token = SessionStore.sessionToken else {
            throw OrgProfileError.notSignedIn
        }
        guard let url = URL(string: "orgs/\(parts[0])/\(parts[1])/profile", relativeTo: backendBaseURL) else {
            throw OrgProfileError.notSignedIn
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 20
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw OrgProfileError.server(String(localized: "No response from the server."))
        }
        return (data, http)
    }

    private static func message(from data: Data) -> String? {
        (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["message"] as? String
    }
}
