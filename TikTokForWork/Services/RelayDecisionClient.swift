import Foundation

/// Decisions are resolved by the relay (`server/decisions.js`), not by each
/// client. That is the whole point of this file: the status transition, the
/// `Condition:` / `Reason:` / `Revision:` note formatting, the response card
/// back to the sender, delegation fan-out and the decision-memory entry are
/// written once and behave identically on iOS, on the web, and anywhere later.
///
/// GitHub stays on the client. The relay syncs issues only for callers whose
/// *session* carries a GitHub token; iOS authenticates with the relay token
/// and holds the user's OAuth token itself, so it performs its own sync after
/// the decision lands and publishes the issue link as an update.
enum DecisionAction: String {
    case approve
    case reject
    case revise
    case acknowledge
    case delegate
    case priority
}

enum RelayDecisionError: LocalizedError {
    case notConfigured
    case alreadyDecided
    case notFound
    case server(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            "No relay connection — deciding needs one."
        case .alreadyDecided:
            "Someone already decided this card."
        case .notFound:
            "That card is no longer in your feed."
        case .server(let message):
            message
        }
    }
}

private struct DecideRequest: Encodable {
    let cardId: String
    let action: String
    let actorUserID: String
    let note: String?
    let delegateToUserID: String?
    let priority: String?
}

private struct DecideResponse: Decodable {
    let card: DecisionCard
}

private struct RelayErrorBody: Decodable {
    let message: String?
}

@MainActor
final class RelayDecisionClient {
    private var baseURL: URL?
    private var token: String?

    var isConfigured: Bool { baseURL != nil }

    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            for formatter in [ISO8601DateFormatter.fractional, ISO8601DateFormatter.standard] {
                if let date = formatter.date(from: value) {
                    return date
                }
            }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid date: \(value)")
        }
        return decoder
    }()

    func configure(baseURL: URL?, token: String?) {
        self.baseURL = baseURL
        self.token = token
    }

    /// Returns the relay's version of the card — authoritative, including any
    /// context notes it appended. The matching `card_updated` broadcast also
    /// arrives over the socket; applying both is idempotent.
    func decide(
        cardID: String,
        action: DecisionAction,
        actorUserID: String,
        note: String? = nil,
        delegateToUserID: String? = nil,
        priority: CardPriority? = nil
    ) async throws -> DecisionCard {
        guard let baseURL, let url = URL(string: "/cards/decide", relativeTo: baseURL) else {
            throw RelayDecisionError.notConfigured
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.httpBody = try JSONEncoder().encode(
            DecideRequest(
                cardId: cardID,
                action: action.rawValue,
                actorUserID: actorUserID,
                note: note,
                delegateToUserID: delegateToUserID,
                priority: priority?.rawValue
            )
        )

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw RelayDecisionError.server("The relay returned an invalid response.")
        }

        switch http.statusCode {
        case 200...299:
            return try decoder.decode(DecideResponse.self, from: data).card
        case 409:
            // Two people reached the same card — a real outcome, not a failure.
            // The relay's wording is more precise than ours (it also covers
            // "you can't re-prioritise something already decided").
            if let message = (try? JSONDecoder().decode(RelayErrorBody.self, from: data))?.message {
                throw RelayDecisionError.server(message)
            }
            throw RelayDecisionError.alreadyDecided
        case 404:
            throw RelayDecisionError.notFound
        default:
            let message = (try? JSONDecoder().decode(RelayErrorBody.self, from: data))?.message
            throw RelayDecisionError.server(
                message ?? "The relay refused the decision (\(http.statusCode))."
            )
        }
    }
}
