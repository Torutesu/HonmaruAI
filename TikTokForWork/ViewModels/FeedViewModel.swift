import Foundation
import SwiftUI

@MainActor
final class FeedViewModel: ObservableObject {
    @Published var cards: [DecisionCard] = []
    @Published var scrollPosition: String?
    @Published var isProcessing = false
    @Published var isDrafting = false
    @Published var processingMessage = ""
    @Published var errorMessage: String?
    @Published var detailCard: DecisionCard?
    @Published var delegateCard: DecisionCard?
    @Published var reviseCard: DecisionCard?
    @Published var reviewDraft: InstructionDraft?
    @Published var unreadCount = 0

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
        service.onError = { [weak self] message in
            self?.errorMessage = message
        }
        unreadCount = service.unreadNotifications
        service.onInboxUpdated = { [weak self, weak service] in
            guard let self, let service else { return }
            self.unreadCount = service.unreadNotifications
        }
    }

    func clearSheets() {
        detailCard = nil
        delegateCard = nil
        reviseCard = nil
        reviewDraft = nil
        isDrafting = false
    }

    func handle(action: CardActionKind, for card: DecisionCard, appState: AppState) async {
        switch action {
        case .delegate:
            delegateCard = card
            return
        case .requestRevision:
            reviseCard = card
            return
        case .viewDetails:
            detailCard = card
            return
        default:
            break
        }
        await send(action: action, card: card, note: nil, delegateTo: nil)
    }

    func completeRevision(for card: DecisionCard, note: String, appState: AppState) async {
        reviseCard = nil
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        await send(action: .requestRevision, card: card, note: trimmed.isEmpty ? nil : trimmed, delegateTo: nil)
    }

    func completeDelegate(for card: DecisionCard, to user: User, appState: AppState) async {
        delegateCard = nil
        await send(action: .delegate, card: card, note: nil, delegateTo: user.id)
    }

    // Instruction pipeline: the server routes instantly (fast path) and an
    // AI refinement upgrades the card moments later — so there is no local
    // draft/review step anymore. Send and watch the feed.
    func sendInstruction(_ text: String, priority: CardPriority, appState: AppState) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let cardService else { return }

        errorMessage = nil
        Task {
            do {
                try await cardService.sendInstruction(
                    text: trimmed,
                    priority: priority == .medium ? nil : priority
                )
                Haptics.light()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func send(
        action: CardActionKind,
        card: DecisionCard,
        note: String?,
        delegateTo: String?
    ) async {
        guard let cardService else { return }
        errorMessage = nil
        do {
            try await cardService.send(
                action: action,
                card: card,
                note: note,
                delegateToUserID: delegateTo
            )
            Haptics.success()
            advanceIfNeeded()
        } catch {
            errorMessage = error.localizedDescription
            Haptics.light()
        }
    }

    private func refreshCards(from service: DecisionCardService) {
        guard let userID else { return }
        let previousCount = cards.count
        let updated = service.cards(for: userID)
        cards = updated

        if updated.isEmpty {
            scrollPosition = nil
        } else if updated.count > previousCount, let newest = updated.first?.id {
            scrollPosition = newest
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
