import Foundation

enum BackendAPIError: LocalizedError {
    case badURL
    case server(String)

    var errorDescription: String? {
        switch self {
        case .badURL: "Invalid backend URL."
        case .server(let message): message
        }
    }
}

// REST client for protocol v1 (backend/packages/protocol/src/rest.ts).
struct BackendAPI {
    let baseURL: URL

    struct AuthResponse: Decodable {
        let token: String
        let user: ProtocolUser
    }

    struct ProtocolUser: Decodable {
        let id: String
        let name: String
    }

    struct MeResponse: Decodable {
        let user: ProtocolUser
        let orgs: [ProtocolOrg]
    }

    func devLogin(name: String) async throws -> AuthResponse {
        try await request("v1/auth/dev", method: "POST", token: nil, body: ["name": name])
    }

    func me(token: String) async throws -> MeResponse {
        try await request("v1/me", method: "GET", token: token, body: nil)
    }

    func createOrg(token: String, name: String, title: String) async throws -> ProtocolOrg {
        struct Response: Decodable { let org: ProtocolOrg }
        let response: Response = try await request(
            "v1/orgs", method: "POST", token: token,
            body: ["name": name, "title": title]
        )
        return response.org
    }

    func acceptInvite(token: String, code: String, title: String) async throws -> ProtocolOrg {
        struct Response: Decodable { let org: ProtocolOrg }
        let response: Response = try await request(
            "v1/invites/accept", method: "POST", token: token,
            body: ["code": code, "title": title]
        )
        return response.org
    }

    func createInvite(token: String, orgID: String) async throws -> String {
        struct Response: Decodable { let code: String }
        let response: Response = try await request(
            "v1/orgs/\(orgID)/invites", method: "POST", token: token, body: [:]
        )
        return response.code
    }

    func listChannels(token: String, orgID: String) async throws -> [ChatChannel] {
        struct Response: Decodable { let channels: [ChatChannel] }
        let response: Response = try await request(
            "v1/orgs/\(orgID)/channels", method: "GET", token: token, body: nil
        )
        return response.channels
    }

    func openDm(token: String, orgID: String, userID: String) async throws -> ChatChannel {
        struct Response: Decodable { let channel: ChatChannel }
        let response: Response = try await request(
            "v1/orgs/\(orgID)/dms", method: "POST", token: token, body: ["userId": userID]
        )
        return response.channel
    }

    func createChannel(token: String, orgID: String, name: String) async throws -> ChatChannel {
        struct Response: Decodable { let channel: ChatChannel }
        let response: Response = try await request(
            "v1/orgs/\(orgID)/channels", method: "POST", token: token, body: ["name": name]
        )
        return response.channel
    }

    func listChatMessages(token: String, channelID: String) async throws -> [ChatMessage] {
        struct Response: Decodable { let messages: [ChatMessage] }
        let response: Response = try await request(
            "v1/channels/\(channelID)/messages", method: "GET", token: token, body: nil
        )
        return response.messages
    }

    func summarizeChannel(token: String, channelID: String) async throws {
        struct Response: Decodable { let queued: Bool }
        let _: Response = try await request(
            "v1/channels/\(channelID)/summarize", method: "POST", token: token, body: [:]
        )
    }

    func listMessages(token: String, cardID: String) async throws -> [CardMessage] {
        struct Response: Decodable { let messages: [CardMessage] }
        let response: Response = try await request(
            "v1/cards/\(cardID)/messages", method: "GET", token: token, body: nil
        )
        return response.messages
    }

    func listNotifications(
        token: String,
        orgID: String
    ) async throws -> (notifications: [NotificationItem], unread: Int) {
        struct Response: Decodable {
            let notifications: [NotificationItem]
            let unreadCount: Int
        }
        let response: Response = try await request(
            "v1/orgs/\(orgID)/notifications", method: "GET", token: token, body: nil
        )
        return (response.notifications, response.unreadCount)
    }

    func markAllNotificationsRead(token: String) async throws {
        struct Body: Encodable { let all = true }
        struct Response: Decodable { let updated: Int }
        let _: Response = try await requestEncodable(
            "v1/notifications/read", method: "POST", token: token, body: Body()
        )
    }

    private func request<T: Decodable>(
        _ path: String,
        method: String,
        token: String?,
        body: [String: String]?
    ) async throws -> T {
        if let body {
            return try await requestEncodable(path, method: method, token: token, body: body)
        }
        return try await requestEncodable(
            path, method: method, token: token, body: Optional<[String: String]>.none
        )
    }

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            let fractional = ISO8601DateFormatter()
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let standard = ISO8601DateFormatter()
            standard.formatOptions = [.withInternetDateTime]
            if let date = fractional.date(from: value) ?? standard.date(from: value) {
                return date
            }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid date: \(value)")
        }
        return decoder
    }()

    private func requestEncodable<T: Decodable, B: Encodable>(
        _ path: String,
        method: String,
        token: String?,
        body: B?
    ) async throws -> T {
        let url = baseURL.appending(path: path)
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
        }

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw BackendAPIError.server("No response.")
        }
        guard (200..<300).contains(http.statusCode) else {
            struct ErrorBody: Decodable { let message: String? }
            let parsed = try? JSONDecoder().decode(ErrorBody.self, from: data)
            throw BackendAPIError.server(parsed?.message ?? "Request failed (\(http.statusCode)).")
        }
        return try Self.decoder.decode(T.self, from: data)
    }
}
