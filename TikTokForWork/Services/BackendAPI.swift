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

    private func request<T: Decodable>(
        _ path: String,
        method: String,
        token: String?,
        body: [String: String]?
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
        return try JSONDecoder().decode(T.self, from: data)
    }
}
