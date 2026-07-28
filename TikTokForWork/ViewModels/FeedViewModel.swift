import Foundation
import SwiftUI

@MainActor
final class FeedViewModel: ObservableObject {
    @Published var cards: [DecisionCard] = []
    @Published var scrollPosition: String?
    @Published var isProcessing = false
    @Published var processingMessage = ""
    @Published var errorMessage: String?
    @Published var detailCard: DecisionCard?
    @Published var delegateCard: DecisionCard?

    private var cardService: DecisionCardService?
    private var userID: String?

    var currentIndex: Int {
        guard let scrollPosition,
              let index = cards.firstIndex(where: { $0.id == scrollPosition }) else {
            return 0
        }
        return index
    }

    var pendingCount: Int {
        cards.filter(\.isPending).count
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
        switch action {
        case .delegate:
            delegateCard = card
            return
        case .viewDetails:
            detailCard = card
            return
        default:
            break
        }

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

    func completeDelegate(for card: DecisionCard, to user: User, appState: AppState) async {
        guard let cardService, let userID else { return }

        isProcessing = true
        processingMessage = "Delegating"
        errorMessage = nil

        do {
            _ = try await cardService.delegate(
                cardID: card.id,
                to: user.id,
                actorUserID: userID,
                organization: DemoData.organization,
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
        delegateCard = nil
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

        if updated.isEmpty {
            scrollPosition = nil
        } else if let scrollPosition, updated.contains(where: { $0.id == scrollPosition }) {
            return
        } else if currentIndex < updated.count {
            self.scrollPosition = updated[currentIndex].id
        } else {
            scrollPosition = updated.first?.id
        }
    }

    private func advanceIfNeeded() {
        let index = currentIndex
        if index < cards.count - 1 {
            withAnimation(.easeOut(duration: 0.25)) {
                scrollPosition = cards[index + 1].id
            }
        }
    }
}
