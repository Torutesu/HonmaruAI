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

    func routeInstruction(
        text: String,
        sender: User,
        organization: OrganizationGraph
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
            RouteInstructionRequest(text: text, sender: sender, organization: organization)
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
            routingReason: routingReason
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
