import Foundation

@MainActor
final class AppState: ObservableObject {
    @Published var currentUser: User?
    @Published var isAuthenticated = false

    let cardService = DecisionCardService()
    let githubService = GitHubService()
    let webSocketService = WebSocketService()
    let aiService = AIService()

    var relayURL = "ws://127.0.0.1:8080"

    init() {
        cardService.attach(webSocketService: webSocketService)
    }
}
