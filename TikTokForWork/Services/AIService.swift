import Foundation

enum AIServiceError: LocalizedError {
    case notConfigured
    case invalidResponse
    case serverError(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            String(localized: "AI routing is not configured on the relay server.")
        case .invalidResponse:
            String(localized: "AI returned an invalid routing response.")
        case .serverError(let message):
            message
        }
    }
}

private struct RouteInstructionRequest: Encodable {
    let text: String
    let sender: User
    let organization: OrganizationGraph
    let priorityOverride: String?
    /// The language the person deciding reads in. The sender's language is
    /// theirs; the card is written for whoever has to act on it.
    let readerLanguage: String
    /// What the sender told their AI about how they work.
    let senderContext: String?
}

private struct RouteInstructionResponse: Decodable {
    let recipientUserID: String
    let cardType: String
    let title: String
    let summary: String
    let context: String
    let priority: String
    let agentRoute: String?
    let routingReason: String?
    let labels: [String]?
    let toolCalls: [AgentToolCall]?
    /// Present and true only when the free daily AI quota was spent and the
    /// server fell back to keyword routing.
    let quotaExceeded: Bool?
}

/// A card, rewritten by the reader's own AI at their request.
struct CardRefinement: Decodable {
    let title: String
    let summary: String
    let context: String
    let priority: String

    var cardPriority: CardPriority? { CardPriority(rawValue: priority) }
}

private struct HealthResponse: Decodable {
    let aiRouting: Bool?
    let aiModel: String?
}

@MainActor
final class AIService: ObservableObject {
    private var backendBaseURL: URL?
    @Published private(set) var modelName: String?

    var isConfigured: Bool {
        modelName != nil
    }

    var hasRelay: Bool {
        backendBaseURL != nil
    }

    /// Sets the backend and kicks off the AI-availability probe in the
    /// background. App entry must NOT block on reachability, so this is
    /// deliberately non-async — a slow or stalled `/health` can never hold the
    /// launch screen.
    func configure(backendBaseURL: URL) {
        self.backendBaseURL = backendBaseURL
        Task { await refreshAvailability() }
    }

    func refreshAvailability() async {
        guard let backendBaseURL else {
            modelName = nil
            return
        }

        guard let url = URL(string: "/health", relativeTo: backendBaseURL) else {
            modelName = nil
            return
        }

        do {
            var request = URLRequest(url: url)
            request.timeoutInterval = 6
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                modelName = nil
                return
            }

            let health = try JSONDecoder().decode(HealthResponse.self, from: data)
            modelName = health.aiRouting == true ? health.aiModel : nil
        } catch {
            modelName = nil
        }
    }

    func draftInstruction(
        text: String,
        sender: User,
        organization: OrganizationGraph,
        priorityOverride: CardPriority? = nil,
        readerLanguage: String,
        senderContext: String?
    ) async throws -> InstructionDraft {
        let routing = try await routeInstruction(
            text: text,
            sender: sender,
            organization: organization,
            priorityOverride: priorityOverride,
            readerLanguage: readerLanguage,
            senderContext: senderContext
        )

        return InstructionDraft(
            id: UUID().uuidString,
            sourceText: text,
            recipientUserID: routing.recipientID,
            cardType: routing.cardType,
            title: routing.title,
            summary: routing.summary,
            context: routing.context,
            priority: routing.priority,
            agentRoute: routing.agentRoute,
            routingReason: routing.routingReason,
            labels: routing.labels,
            toolCalls: routing.toolCalls,
            quotaExceeded: routing.quotaExceeded
        )
    }

    func routeInstruction(
        text: String,
        sender: User,
        organization: OrganizationGraph,
        priorityOverride: CardPriority? = nil,
        readerLanguage: String,
        senderContext: String?
    ) async throws -> InstructionRouting {
        guard let backendBaseURL else {
            throw AIServiceError.notConfigured
        }
        guard let url = URL(string: "/ai/route", relativeTo: backendBaseURL) else {
            throw AIServiceError.invalidResponse
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let key = SessionStore.apiKey, !key.isEmpty {
            request.setValue(key, forHTTPHeaderField: "x-ai-key")
        }
        request.httpBody = try JSONEncoder().encode(
            RouteInstructionRequest(
                text: text,
                sender: sender,
                organization: organization,
                priorityOverride: priorityOverride?.rawValue,
                readerLanguage: readerLanguage,
                senderContext: senderContext
            )
        )

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw AIServiceError.invalidResponse
        }

        guard (200...299).contains(http.statusCode) else {
            let message = parseServerError(data) ?? String(localized: "AI routing request failed.")
            throw AIServiceError.serverError(message)
        }

        let routingResponse = try JSONDecoder().decode(RouteInstructionResponse.self, from: data)
        guard
            let cardType = CardType(rawValue: routingResponse.cardType),
            let priority = CardPriority(rawValue: routingResponse.priority)
        else {
            throw AIServiceError.invalidResponse
        }

        let recipientName = name(for: routingResponse.recipientUserID, in: organization)
        let agentRoute = routingResponse.agentRoute
            ?? "\(sender.name)'s AI → \(recipientName)'s AI"
        let routingReason = routingResponse.routingReason
            ?? organization.routingReason(
                recipientID: routingResponse.recipientUserID,
                senderID: sender.id,
                namedInInstruction: false
            )

        return InstructionRouting(
            recipientID: routingResponse.recipientUserID,
            cardType: cardType,
            title: routingResponse.title,
            summary: routingResponse.summary,
            context: routingResponse.context,
            priority: priority,
            agentRoute: agentRoute,
            routingReason: routingReason,
            labels: routingResponse.labels ?? [],
            toolCalls: routingResponse.toolCalls ?? [],
            quotaExceeded: routingResponse.quotaExceeded ?? false
        )
    }

    /// Ask your AI to rework the card in front of you.
    ///
    /// Your card, your AI: it rewrites what you are looking at — pull the
    /// numbers out, shorten it, say what is actually being asked — and sends
    /// nothing to anyone. There is no keyword version of "do what I just
    /// asked", so unlike routing this has no offline fallback: it says it
    /// cannot rather than answering something else.
    func refine(
        card: DecisionCard,
        instruction: String,
        readerLanguage: String
    ) async throws -> CardRefinement {
        guard let backendBaseURL, let token = SessionStore.sessionToken else {
            throw AIServiceError.notConfigured
        }
        guard let url = URL(string: "/ai/refine", relativeTo: backendBaseURL) else {
            throw AIServiceError.invalidResponse
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 40
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        if let key = SessionStore.apiKey, !key.isEmpty {
            request.setValue(key, forHTTPHeaderField: "x-ai-key")
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "instruction": instruction,
            "readerLanguage": readerLanguage,
            "card": [
                "id": card.id,
                "recipientUserID": card.recipientUserID,
                "senderUserID": card.senderUserID,
                "title": card.title,
                "summary": card.summary,
                "context": card.context,
                "priority": card.priority.rawValue,
            ],
        ])

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw AIServiceError.invalidResponse
        }
        guard (200...299).contains(http.statusCode) else {
            throw AIServiceError.serverError(
                parseServerError(data) ?? String(localized: "Your AI could not answer that.")
            )
        }
        return try JSONDecoder().decode(CardRefinement.self, from: data)
    }

    private func name(for userID: String, in organization: OrganizationGraph) -> String {
        DisplayName.of(userID, in: organization)
    }

    private func parseServerError(_ data: Data) -> String? {
        guard
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let message = json["message"] as? String
        else {
            return nil
        }
        return message
    }
}
