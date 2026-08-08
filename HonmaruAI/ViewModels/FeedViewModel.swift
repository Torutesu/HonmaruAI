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

    private var cardService: DecisionCardService?
    private var githubService: GitHubService?
    private var userID: String?
    private var draftTask: Task<Void, Never>?
    private var githubSyncTask: Task<Void, Never>?

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

    func bind(to service: DecisionCardService, user: User, githubService: GitHubService) {
        cardService = service
        self.githubService = githubService
        userID = user.id
        refreshCards(from: service)

        service.onCardsUpdated = { [weak self] in
            guard let self, let cardService = self.cardService else { return }
            withAnimation(.easeOut(duration: 0.2)) {
                self.refreshCards(from: cardService)
            }
        }

        githubSyncTask?.cancel()
        githubSyncTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.syncGitHub()
                try? await Task.sleep(for: .seconds(30))
            }
        }
    }

    func syncGitHub() async {
        guard let cardService, let githubService else { return }
        await cardService.syncGitHubStatus(githubService: githubService)
        refreshCards(from: cardService)
    }

    func clearSheets() {
        detailCard = nil
        delegateCard = nil
        reviseCard = nil
        reviewDraft = nil
        draftTask?.cancel()
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
        case .delete:
            await delete(card: card, appState: appState)
            return
        case .viewDetails:
            detailCard = card
            return
        default:
            break
        }

        await resolve(card: card, action: action, revisionNote: nil, appState: appState)
    }

    func completeRevision(for card: DecisionCard, note: String, appState: AppState) async {
        reviseCard = nil
        await resolve(card: card, action: .requestRevision, revisionNote: note, appState: appState)
    }

    func delete(card: DecisionCard, appState: AppState) async {
        guard let cardService, let userID else { return }

        isProcessing = true
        processingMessage = "Removing card"
        errorMessage = nil

        do {
            try await cardService.delete(cardID: card.id, actorUserID: userID)
            Haptics.light()
            refreshCards(from: cardService)
            if cards.isEmpty {
                scrollPosition = nil
            } else if scrollPosition == card.id {
                scrollPosition = cards[min(currentIndex, cards.count - 1)].id
            }
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

    func beginDraft(_ text: String, priority: CardPriority, appState: AppState) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        draftTask?.cancel()
        errorMessage = nil
        isDrafting = true

        draftTask = Task {
            let draft = await draftInstruction(trimmed, priority: priority, appState: appState)
            guard !Task.isCancelled else { return }
            isDrafting = false
            if let draft {
                reviewDraft = draft
            }
        }
    }

    func draftInstruction(_ text: String, priority: CardPriority, appState: AppState) async -> InstructionDraft? {
        guard let user = appState.currentUser else { return nil }
        guard appState.aiService.hasRelay else {
            errorMessage = AIServiceError.notConfigured.localizedDescription
            return nil
        }

        do {
            return try await appState.aiService.draftInstruction(
                text: text,
                sender: user,
                organization: DemoData.organization,
                priorityOverride: priority
            )
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func sendDraft(_ draft: InstructionDraft, appState: AppState) async {
        guard let cardService, let user = appState.currentUser else { return }

        isProcessing = true
        processingMessage = "Routing decision"
        errorMessage = nil

        do {
            let routing = draft.asRouting()
            _ = try await cardService.processRouting(
                routing,
                sourceText: draft.sourceText,
                from: user
            )
            refreshCards(from: cardService)
            Haptics.light()
        } catch {
            errorMessage = error.localizedDescription
        }

        isProcessing = false
        reviewDraft = nil
    }

    private func resolve(
        card: DecisionCard,
        action: CardActionKind,
        revisionNote: String?,
        appState: AppState
    ) async {
        guard let cardService, let userID else { return }

        isProcessing = true
        processingMessage = switch action {
        case .createIssue: "Creating GitHub issue…"
        case .reject: "Declining"
        case .requestRevision: "Sending revision"
        default: "Syncing"
        }
        errorMessage = nil

        do {
            _ = try await cardService.resolve(
                cardID: card.id,
                action: action,
                actorUserID: userID,
                revisionNote: revisionNote,
                githubService: appState.githubService
            )
            Haptics.success()
            refreshCards(from: cardService)
            await syncGitHub()
            advanceIfNeeded()
        } catch {
            errorMessage = error.localizedDescription
            Haptics.light()
        }

        isProcessing = false
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
