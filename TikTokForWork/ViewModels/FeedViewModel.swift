import Foundation
import SwiftUI

@MainActor
final class FeedViewModel: ObservableObject {
    @Published var cards: [DecisionCard] = []
    @Published var currentIndex = 0
    @Published var isProcessing = false
    @Published var processingMessage = ""
    @Published var errorMessage: String?

    private var cardService: DecisionCardService?
    private var userID: String?

    var pendingCount: Int {
        cards.filter(\.isPending).count
    }

    var positionLabel: String? {
        guard !cards.isEmpty else { return nil }
        return "\(currentIndex + 1) / \(cards.count)"
    }

    func bind(to service: DecisionCardService, user: User) {
        cardService = service
        userID = user.id
        refreshCards(from: service)

        service.onCardsUpdated = { [weak self] in
            guard let self, let cardService = self.cardService else { return }
            withAnimation(.easeOut(duration: 0.2)) {
                self.refreshCards(from: cardService)
            }
        }
    }

    func handle(action: CardActionKind, for card: DecisionCard, appState: AppState) async {
        guard let cardService, let userID else { return }

        isProcessing = true
        processingMessage = "Syncing to GitHub"
        errorMessage = nil

        do {
            _ = try await cardService.resolve(
                cardID: card.id,
                action: action,
                actorUserID: userID,
                githubService: appState.githubService
            )
            Haptics.success()
            refreshCards(from: cardService)
            advanceIfNeeded()
        } catch {
            errorMessage = error.localizedDescription
            Haptics.light()
        }

        isProcessing = false
    }

    func sendInstruction(_ text: String, appState: AppState) async {
        guard let cardService, let user = appState.currentUser else { return }

        isProcessing = true
        processingMessage = appState.aiService.isConfigured ? "Routing with AI" : "Routing"
        errorMessage = nil

        do {
            _ = try await cardService.processInstruction(
                text,
                from: user,
                organization: DemoData.organization,
                aiService: appState.aiService
            )
            refreshCards(from: cardService)
            Haptics.light()
        } catch {
            errorMessage = error.localizedDescription
        }

        isProcessing = false
    }

    private func refreshCards(from service: DecisionCardService) {
        guard let userID else { return }
        let updated = service.cards(for: userID)
        cards = updated
        if currentIndex >= updated.count {
            currentIndex = max(0, updated.count - 1)
        }
    }

    private func advanceIfNeeded() {
        if currentIndex < cards.count - 1 {
            withAnimation(.easeOut(duration: 0.25)) {
                currentIndex += 1
            }
        }
    }
}
