import Foundation

/// Somebody in a workspace, as a client is allowed to see them.
///
/// There is no login and no account id here on purpose: for anyone who signed
/// in with an email address, both of those *are* the address, and a member
/// list is read by everyone on the team. `ref` is the handle — enough to
/// remove somebody, and not the name of an inbox.
struct TeamMember: Identifiable, Decodable, Equatable {
    let ref: String
    let name: String
    let role: String
    let title: String?
    let mine: Bool

    var id: String { ref }
}

/// A code that is still open into this workspace.
///
/// `code` is nil for one minted at a role above your own: reading it would be
/// a promotion you could not otherwise grant. It can still be cancelled, by
/// `ref`.
struct TeamInvite: Identifiable, Decodable, Equatable {
    let ref: String
    let code: String?
    let role: String
    let creator: String
    let mine: Bool
    let uses: Int
    let maxUses: Int

    var id: String { ref }
}

enum TeamServiceError: LocalizedError {
    case notConfigured
    case server(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured: String(localized: "This device is not signed in to a workspace.")
        case .server(let message): message
        }
    }
}

/// Who is in this workspace, what is still open into it, and one more way in.
///
/// Inviting was the whole of team management on the phone — and it was not
/// even that: nothing here could mint a code at all. The one screen that
/// answered "who is here" read a GitHub repository's collaborators, so it
/// answered nothing for anyone who signed in with an email address, which is
/// the only way in on a phone.
enum TeamService {
    private struct Members: Decodable { let members: [TeamMember]; let editable: Bool }
    private struct Invites: Decodable { let invites: [TeamInvite] }
    private struct Minted: Decodable { let code: String }
    private struct Failure: Decodable { let message: String? }

    private static func request(_ path: String, method: String = "GET", body: [String: Any]? = nil, backendBaseURL: URL) throws -> URLRequest {
        guard let token = SessionStore.sessionToken,
              let url = URL(string: path, relativeTo: backendBaseURL) else {
            throw TeamServiceError.notConfigured
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 20
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return request
    }

    /// The server's own sentence when it refuses, not ours.
    ///
    /// Every refusal here is something a person did — removing somebody above
    /// their own role, cancelling a code that is not theirs — and the reason is
    /// the useful part of the answer.
    private static func check(_ data: Data, _ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else { return }
        guard (200...299).contains(http.statusCode) else {
            let said = (try? JSONDecoder().decode(Failure.self, from: data))?.message
            throw TeamServiceError.server(said ?? String(localized: "That did not work."))
        }
    }

    static func members(orgId: String, backendBaseURL: URL) async throws -> (members: [TeamMember], editable: Bool) {
        let path = "members?orgId=\(orgId.addingPercentEncoding(withAllowedCharacters: .urlQueryValueAllowed) ?? orgId)"
        let (data, response) = try await URLSession.shared.data(for: try request(path, backendBaseURL: backendBaseURL))
        try check(data, response)
        let decoded = try JSONDecoder().decode(Members.self, from: data)
        return (decoded.members, decoded.editable)
    }

    static func invites(orgId: String, backendBaseURL: URL) async throws -> [TeamInvite] {
        let path = "invites?orgId=\(orgId.addingPercentEncoding(withAllowedCharacters: .urlQueryValueAllowed) ?? orgId)"
        let (data, response) = try await URLSession.shared.data(for: try request(path, backendBaseURL: backendBaseURL))
        try check(data, response)
        return try JSONDecoder().decode(Invites.self, from: data).invites
    }

    static func mintInvite(orgId: String, role: String, backendBaseURL: URL) async throws -> String {
        let req = try request("invites/create", method: "POST", body: ["orgId": orgId, "role": role], backendBaseURL: backendBaseURL)
        let (data, response) = try await URLSession.shared.data(for: req)
        try check(data, response)
        return try JSONDecoder().decode(Minted.self, from: data).code
    }

    static func revokeInvite(orgId: String, ref: String, backendBaseURL: URL) async throws {
        let req = try request("invites", method: "DELETE", body: ["orgId": orgId, "ref": ref], backendBaseURL: backendBaseURL)
        let (data, response) = try await URLSession.shared.data(for: req)
        try check(data, response)
    }

    /// Remove somebody, or let yourself out. The server decides which is
    /// allowed; standing is not a thing a client gets to assert.
    static func removeMember(orgId: String, ref: String, backendBaseURL: URL) async throws {
        let req = try request("members", method: "DELETE", body: ["orgId": orgId, "ref": ref], backendBaseURL: backendBaseURL)
        let (data, response) = try await URLSession.shared.data(for: req)
        try check(data, response)
    }

    /// The address that turns a forwarded email into a card. `nil` when this
    /// deployment has no inbound domain — there is simply nothing to hand out,
    /// which is not an error to put in front of anybody.
    static func inboundAddress(backendBaseURL: URL) async -> String? {
        struct Address: Decodable { let address: String }
        guard let req = try? request("connectors/email/address", backendBaseURL: backendBaseURL),
              let (data, response) = try? await URLSession.shared.data(for: req),
              let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else { return nil }
        return (try? JSONDecoder().decode(Address.self, from: data))?.address
    }
}

extension CharacterSet {
    /// `urlQueryAllowed` permits "/" and "&", and an org id is "owner/repo".
    /// Percent-encoding it with that set leaves the slash in place and the
    /// query names a different org than the one asked for.
    static let urlQueryValueAllowed: CharacterSet = {
        var set = CharacterSet.urlQueryAllowed
        set.remove(charactersIn: "/&+=?#")
        return set
    }()
}
