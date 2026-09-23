import Foundation

/// The loop the product improves through, from the phone's side: say a card
/// was wrong, and read how the feed is doing. Both are the Worker's routes;
/// nothing here is computed on the device.
enum InsightsService {
    enum Failure: LocalizedError {
        case notSignedIn
        case forbidden
        case server(Int)

        var errorDescription: String? {
            switch self {
            case .notSignedIn: String(localized: "Sign in to see how your feed is doing.")
            case .forbidden: String(localized: "You are not a member of this workspace.")
            case .server(let code): String(localized: "Insights request failed (\(code)).")
            }
        }
    }

    /// Why a card was wrong. The four the Worker accepts; the raw value is the
    /// wire format.
    enum FlagReason: String, CaseIterable, Identifiable {
        case wrongPerson = "wrong-person"
        case notADecision = "not-a-decision"
        case wrongPriority = "wrong-priority"
        case wrongWords = "wrong-words"

        var id: String { rawValue }

        var label: String {
            switch self {
            case .wrongPerson: String(localized: "Wrong person")
            case .notADecision: String(localized: "Not a decision")
            case .wrongPriority: String(localized: "Wrong priority")
            case .wrongWords: String(localized: "Badly written")
            }
        }
    }

    struct Metrics: Decodable {
        struct Day: Decodable { let day: String; let count: Int }
        struct Count: Decodable, Identifiable {
            let label: String
            let count: Int
            var id: String { label }
        }
        struct Feedback: Decodable {
            let right: Int
            let wrong: Int
            let reasons: [String: Int]
        }

        let days: Int
        let cards: Int
        let pending: Int
        let decided: Int
        let selfAddressed: Int
        let medianMinutesToDecide: Double?
        let declineRate: Double?
        let nudges: Int
        let created: [Day]
        let bySource: [Count]
        let byAction: [Count]
        let feedback: Feedback

        private enum CodingKeys: String, CodingKey {
            case days, cards, pending, decided, selfAddressed, medianMinutesToDecide, declineRate, nudges, created, bySource, byAction, feedback
        }

        // The Worker names the key of each count after what it counts
        // ("source", "action"); one shape here keeps the two lists one view.
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            days = try c.decode(Int.self, forKey: .days)
            cards = try c.decode(Int.self, forKey: .cards)
            pending = try c.decode(Int.self, forKey: .pending)
            decided = try c.decode(Int.self, forKey: .decided)
            selfAddressed = try c.decodeIfPresent(Int.self, forKey: .selfAddressed) ?? 0
            medianMinutesToDecide = try c.decodeIfPresent(Double.self, forKey: .medianMinutesToDecide)
            declineRate = try c.decodeIfPresent(Double.self, forKey: .declineRate)
            nudges = try c.decodeIfPresent(Int.self, forKey: .nudges) ?? 0
            created = try c.decodeIfPresent([Day].self, forKey: .created) ?? []
            feedback = try c.decode(Feedback.self, forKey: .feedback)
            struct Source: Decodable { let source: String; let count: Int }
            struct Action: Decodable { let action: String; let count: Int }
            bySource = (try c.decodeIfPresent([Source].self, forKey: .bySource) ?? []).map { Count(label: $0.source, count: $0.count) }
            byAction = (try c.decodeIfPresent([Action].self, forKey: .byAction) ?? []).map { Count(label: $0.action, count: $0.count) }
        }
    }

    static func metrics(orgId: String, days: Int, backendBaseURL: URL) async throws -> Metrics {
        guard let token = SessionStore.sessionToken else { throw Failure.notSignedIn }
        var components = URLComponents(url: backendBaseURL, resolvingAgainstBaseURL: true)
        components?.path = "/metrics"
        components?.queryItems = [URLQueryItem(name: "orgId", value: orgId), URLQueryItem(name: "days", value: String(days))]
        guard let url = components?.url else { throw Failure.server(0) }
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw Failure.server(0) }
        switch http.statusCode {
        case 200: return try JSONDecoder().decode(Metrics.self, from: data)
        case 401: throw Failure.notSignedIn
        case 403: throw Failure.forbidden
        default: throw Failure.server(http.statusCode)
        }
    }

    /// One verdict on one card. Fire and forget from the caller's point of
    /// view: a flag that does not land is not worth interrupting a decision
    /// for, and the Worker keeps the latest one per person anyway.
    static func flag(cardId: String, orgId: String, reason: FlagReason, backendBaseURL: URL) async -> Bool {
        guard let token = SessionStore.sessionToken,
              let encoded = cardId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
              let url = URL(string: "cards/\(encoded)/feedback", relativeTo: backendBaseURL) else { return false }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = ["orgId": orgId, "verdict": "wrong", "reason": reason.rawValue]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        guard let (_, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse else { return false }
        return (200...299).contains(http.statusCode)
    }
}
