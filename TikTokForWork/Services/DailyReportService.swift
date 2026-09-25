import Foundation

/// The daily report, from the phone: posting a draft, and setting up when the
/// AI drafts it and where it goes.
///
/// Twice a day by default — the morning plan at 08:00 and the evening report
/// at 22:00, where the person lives — each a routine on the Worker with its
/// own time. The draft arrives as a card; `post` is the only way it leaves.
enum DailyReportService {
    enum Failure: LocalizedError, Equatable {
        case notSignedIn
        /// The Worker said no, in its own words.
        case refused(String)

        var errorDescription: String? {
            switch self {
            case .notSignedIn: String(localized: "Sign in first.")
            case .refused(let message): message
            }
        }
    }

    /// The two halves of the day, as routine kinds on the Worker.
    enum Part: String, CaseIterable, Identifiable {
        case morning = "daily_plan"
        case evening = "daily_report"
        var id: String { rawValue }
        /// 08:00 and 22:00, unless the person says otherwise.
        var defaultHour: Int { self == .morning ? 8 : 22 }
    }

    /// A channel the report can go to.
    struct Channel: Decodable, Hashable, Identifiable {
        let slug: String
        let name: String?
        var id: String { slug }
        var key: String { "b:\(slug)" }
    }

    /// A routine as the Worker lists it — only what the setup needs.
    struct Routine: Decodable, Equatable, Identifiable {
        let id: String
        let kind: String
        let cadence: String
        let hour: Int
        let minute: Int
        let timezone: String
        let enabled: Bool
        let channel: String?
    }

    /// What a team's daily-report channel is called in the languages the
    /// screens speak — so someone joining finds the first person's channel
    /// rather than making another beside it. The web client has the same list.
    static let channelSlugs = ["daily-reports", "日報", "informes-diarios", "rapports-quotidiens", "tagesberichte"]

    /// The body of `POST /channels/daily-report/post`.
    struct Outgoing: Encodable {
        let orgId: String
        let cardId: String
        let text: String
    }

    private struct Posted: Decodable { let card: DecisionCard }
    private struct Channels: Decodable { let businesses: [Channel] }
    private struct Made: Decodable { let business: Channel }
    private struct Routines: Decodable { let routines: [Routine] }
    private struct One: Decodable { let routine: Routine }

    /// Post the draft — as the person left it — to its channel under their
    /// name. Returns the card as posted.
    static func post(cardId: String, orgId: String, text: String, backendBaseURL: URL, session: URLSession = .shared) async throws -> DecisionCard {
        let body = try JSONEncoder().encode(Outgoing(orgId: orgId, cardId: cardId, text: text))
        let data = try await send("POST", path: "channels/daily-report/post", body: body, base: backendBaseURL, session: session)
        return try JSONDecoder.relay().decode(Posted.self, from: data).card
    }

    static func channels(orgId: String, backendBaseURL: URL, session: URLSession = .shared) async throws -> [Channel] {
        let data = try await send("GET", path: "businesses", query: ["orgId": orgId], base: backendBaseURL, session: session)
        return try JSONDecoder().decode(Channels.self, from: data).businesses
    }

    static func makeChannel(named name: String, orgId: String, backendBaseURL: URL, session: URLSession = .shared) async throws -> Channel {
        let body = try JSONSerialization.data(withJSONObject: ["orgId": orgId, "name": name])
        let data = try await send("POST", path: "businesses", body: body, base: backendBaseURL, session: session)
        return try JSONDecoder().decode(Made.self, from: data).business
    }

    /// The person's own routines in this workspace.
    static func routines(orgId: String, backendBaseURL: URL, session: URLSession = .shared) async throws -> [Routine] {
        let data = try await send("GET", path: "routines", query: ["orgId": orgId], base: backendBaseURL, session: session)
        return try JSONDecoder().decode(Routines.self, from: data).routines
    }

    /// Make one half of the day's report, in this phone's time zone.
    @discardableResult
    static func create(_ part: Part, hour: Int, minute: Int, cadence: String, channel: String, orgId: String, timeZone: String = TimeZone.current.identifier, backendBaseURL: URL, session: URLSession = .shared) async throws -> Routine {
        let body = try JSONSerialization.data(withJSONObject: [
            "orgId": orgId, "kind": part.rawValue, "cadence": cadence, "hour": hour, "minute": minute,
            "timezone": timeZone, "channel": channel, "recipient": "me",
        ] as [String: Any])
        let data = try await send("POST", path: "routines", body: body, base: backendBaseURL, session: session)
        return try JSONDecoder().decode(One.self, from: data).routine
    }

    /// Change one: its time, days, channel, or whether it runs.
    @discardableResult
    static func update(_ routineID: String, hour: Int, minute: Int, cadence: String, channel: String, enabled: Bool, orgId: String, timeZone: String = TimeZone.current.identifier, backendBaseURL: URL, session: URLSession = .shared) async throws -> Routine {
        let body = try JSONSerialization.data(withJSONObject: [
            "orgId": orgId, "cadence": cadence, "hour": hour, "minute": minute,
            "timezone": timeZone, "channel": channel, "enabled": enabled,
        ] as [String: Any])
        // `appending(path:)` encodes what needs it; a routine id is a UUID.
        let data = try await send("PUT", path: "routines/\(routineID)", body: body, base: backendBaseURL, session: session)
        return try JSONDecoder().decode(One.self, from: data).routine
    }

    private static func send(_ method: String, path: String, query: [String: String] = [:], body: Data? = nil, base: URL, session: URLSession) async throws -> Data {
        guard let token = SessionStore.sessionToken, !token.isEmpty else { throw Failure.notSignedIn }
        guard var components = URLComponents(url: base.appending(path: path), resolvingAgainstBaseURL: false) else {
            throw Failure.refused(String(localized: "That did not save."))
        }
        if !query.isEmpty { components.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) } }
        guard let url = components.url else { throw Failure.refused(String(localized: "That did not save.")) }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 30
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw Failure.refused(String(localized: "That did not save.")) }
        if http.statusCode == 401 { throw Failure.notSignedIn }
        guard (200...299).contains(http.statusCode) else { throw Failure.refused(message(in: data)) }
        return data
    }

    /// What the Worker said, in its own words when it had any.
    static func message(in data: Data) -> String {
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let message = json["message"] as? String, !message.isEmpty {
            return message
        }
        return String(localized: "That did not save.")
    }
}
