import Foundation

enum AIServiceError: LocalizedError {
    case notConfigured
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .notConfigured: "OpenAI API key not configured."
        case .invalidResponse: "AI returned an invalid routing response."
        }
    }
}

@MainActor
final class AIService: ObservableObject {
    private var apiKey: String?

    var isConfigured: Bool {
        guard let apiKey else { return false }
        return !apiKey.isEmpty
    }

    func configure(apiKey: String) {
        self.apiKey = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func routeInstruction(
        text: String,
        sender: User,
        organization: OrganizationGraph
    ) async throws -> InstructionRouting {
        guard let apiKey, !apiKey.isEmpty else {
            throw AIServiceError.notConfigured
        }

        let orgContext = organizationContext(organization)
        let systemPrompt = """
        You route workplace instructions between AI agents in an organization.
        Return JSON only with keys:
        recipientUserID, cardType, title, summary, context, priority, agentRoute

        recipientUserID must be one of: user-alice, user-bob
        cardType must be one of: approval, delegation, notification, task, revision
        priority must be one of: low, medium, high, urgent
        agentRoute format: "{Sender}'s AI → {Recipient}'s AI"

        Use organization context to pick the right decision owner.
        summary should be concise decision-ready text, not the raw user message.
        context should include role-relevant details only.
        """

        let userPrompt = """
        Sender: \(sender.name) (\(sender.id), \(sender.role))
        Instruction: \(text)

        Organization:
        \(orgContext)
        """

        let body: [String: Any] = [
            "model": "gpt-4o-mini",
            "temperature": 0.2,
            "response_format": ["type": "json_object"],
            "messages": [
                ["role": "system", "content": systemPrompt],
                ["role": "user", "content": userPrompt]
            ]
        ]

        guard let url = URL(string: "https://api.openai.com/v1/chat/completions") else {
            throw AIServiceError.invalidResponse
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            let message = parseOpenAIError(data) ?? "OpenAI request failed."
            throw AIServiceError.invalidResponse
        }

        guard
            let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let choices = json["choices"] as? [[String: Any]],
            let first = choices.first,
            let message = first["message"] as? [String: Any],
            let content = message["content"] as? String,
            let contentData = content.data(using: .utf8),
            let routingJSON = try JSONSerialization.jsonObject(with: contentData) as? [String: Any],
            let recipientUserID = routingJSON["recipientUserID"] as? String,
            let cardTypeRaw = routingJSON["cardType"] as? String,
            let cardType = CardType(rawValue: cardTypeRaw),
            let title = routingJSON["title"] as? String,
            let summary = routingJSON["summary"] as? String,
            let context = routingJSON["context"] as? String,
            let priorityRaw = routingJSON["priority"] as? String,
            let priority = CardPriority(rawValue: priorityRaw)
        else {
            throw AIServiceError.invalidResponse
        }

        let agentRoute = routingJSON["agentRoute"] as? String
            ?? "\(sender.name)'s AI → \(DemoData.userName(for: recipientUserID))'s AI"

        return InstructionRouting(
            recipientID: recipientUserID,
            cardType: cardType,
            title: title,
            summary: summary,
            context: context,
            priority: priority,
            agentRoute: agentRoute
        )
    }

    private func organizationContext(_ organization: OrganizationGraph) -> String {
        let nodes = organization.nodes.map { "- \($0.id): \($0.label) (\($0.kind.rawValue))" }.joined(separator: "\n")
        let edges = organization.edges.map { edge in
            let from = organization.nodes.first { $0.id == edge.fromID }?.label ?? edge.fromID
            let to = organization.nodes.first { $0.id == edge.toID }?.label ?? edge.toID
            return "- \(from) \(edge.kind.rawValue) \(to)"
        }.joined(separator: "\n")
        return "Nodes:\n\(nodes)\nEdges:\n\(edges)"
    }

    private func parseOpenAIError(_ data: Data) -> String? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let error = json["error"] as? [String: Any],
              let message = error["message"] as? String else {
            return nil
        }
        return message
    }
}
