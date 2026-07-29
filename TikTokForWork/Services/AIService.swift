import Foundation

enum AIServiceError: LocalizedError {
    case notConfigured
    case invalidResponse
    case serverError(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            "AI routing is not configured on the relay server."
        case .invalidResponse:
            "AI returned an invalid routing response."
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

    func configure(backendBaseURL: URL) async {
        self.backendBaseURL = backendBaseURL
        await refreshAvailability()
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
            let (data, response) = try await URLSession.shared.data(from: url)
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
        priorityOverride: CardPriority? = nil
    ) async throws -> InstructionDraft {
        let routing = try await routeInstruction(
            text: text,
            sender: sender,
            organization: organization,
            priorityOverride: priorityOverride
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
            toolCalls: routing.toolCalls
        )
    }

    func routeInstruction(
        text: String,
        sender: User,
        organization: OrganizationGraph,
        priorityOverride: CardPriority? = nil
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
        request.httpBody = try JSONEncoder().encode(
            RouteInstructionRequest(
                text: text,
                sender: sender,
                organization: organization,
                priorityOverride: priorityOverride?.rawValue
            )
        )

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw AIServiceError.invalidResponse
        }

        if http.statusCode == 503 {
            throw AIServiceError.notConfigured
        }

        guard (200...299).contains(http.statusCode) else {
            let message = parseServerError(data) ?? "AI routing request failed."
            throw AIServiceError.serverError(message)
        }

        let routingResponse = try JSONDecoder().decode(RouteInstructionResponse.self, from: data)
        guard
            let cardType = CardType(rawValue: routingResponse.cardType),
            let priority = CardPriority(rawValue: routingResponse.priority)
        else {
            throw AIServiceError.invalidResponse
        }

        let recipientName = DemoData.userName(for: routingResponse.recipientUserID)
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
            toolCalls: routingResponse.toolCalls ?? []
        )
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
