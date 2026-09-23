import Foundation

enum WorkspaceMemberService {
    private struct Response: Decodable { let members: [TeamMember] }

    private enum ServiceError: Error {
        case invalidResponse
        case httpStatus(Int)

        var isTransient: Bool {
            guard case let .httpStatus(status) = self else { return false }
            return status == 408 || status == 425 || status == 429 || (500...599).contains(status)
        }
    }

    static func fetch(
        orgID: String,
        baseURL: URL,
        sessionToken: String,
        session: URLSession = .shared,
        maxAttempts: Int = 3
    ) async throws -> [WorkspaceMember] {
        guard var components = URLComponents(url: baseURL.appending(path: "members"), resolvingAgainstBaseURL: true) else { throw URLError(.badURL) }
        components.queryItems = [URLQueryItem(name: "orgId", value: orgID)]
        guard let url = components.url else { throw URLError(.badURL) }
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        request.setValue(sessionToken, forHTTPHeaderField: "x-session-token")

        let attempts = max(1, maxAttempts)
        let ownID = SessionStore.currentUserID
        for attempt in 1...attempts {
            do {
                let (data, response) = try await session.data(for: request)
                guard let http = response as? HTTPURLResponse else { throw ServiceError.invalidResponse }
                guard (200...299).contains(http.statusCode) else { throw ServiceError.httpStatus(http.statusCode) }
                let result = try JSONDecoder().decode(Response.self, from: data)
                return result.members.map {
                    WorkspaceMember(id: $0.mine ? (ownID ?? "member:\($0.ref)") : "member:\($0.ref)",
                                    name: $0.name, role: $0.title ?? $0.role, avatarUrl: nil)
                }
            } catch {
                guard attempt < attempts, isTransient(error) else { throw error }
                // A member refresh happens immediately after sign-in and invite acceptance.
                // Give the edge/database a brief chance to converge instead of leaving the
                // recipient picker disabled after one recoverable response.
                try await Task.sleep(for: .milliseconds(250 * attempt))
            }
        }

        throw ServiceError.invalidResponse
    }

    private static func isTransient(_ error: Error) -> Bool {
        if let error = error as? ServiceError { return error.isTransient }
        guard let error = error as? URLError else { return false }
        return [
            .timedOut,
            .cannotFindHost,
            .cannotConnectToHost,
            .networkConnectionLost,
            .dnsLookupFailed,
            .notConnectedToInternet,
            .internationalRoamingOff,
            .callIsActive,
            .dataNotAllowed,
            .secureConnectionFailed
        ].contains(error.code)
    }
}
