import Foundation

/// Owned by the shell, so a request survives sheet dismissal and tab changes.
@MainActor
final class FeedViewModel: ObservableObject {
    @Published var sourceText = ""
    @Published var title = ""
    @Published var summary = ""
    @Published var context = ""
    @Published var recipientID = ""
    @Published var cardType: CardType = .approval
    @Published var priority: CardPriority = .medium
    @Published var isReviewing = false
    @Published private(set) var isDrafting = false
    @Published private(set) var isSending = false
    @Published var errorMessage: String?
    @Published private(set) var preparationNote: String?
    @Published private(set) var attachmentURL: URL?
    private var generation = UUID()
    private var boundScope: String?
    private var lastQueuedDraft: (cardID: String, sessionID: UUID, source: String, title: String, summary: String, context: String, recipient: String, kind: CardType, priority: CardPriority, attachment: URL?)?

    var validationMessage: String? {
        if title.utf16.count > 300 { return String(localized: "Title must be 300 characters or fewer.") }
        if summary.utf16.count > 2_000 { return String(localized: "Summary must be 2,000 characters or fewer.") }
        if context.utf16.count > 8_000 { return String(localized: "Context must be 8,000 characters or fewer.") }
        return nil
    }

    func restoreRejectedDraft(appState: AppState) {
        guard !hasDraft, let draft = lastQueuedDraft, draft.sessionID == appState.activeSessionID,
              appState.cardService.awaitingDeliveryIDs.contains(draft.cardID) else { return }
        sourceText = draft.source; title = draft.title; summary = draft.summary; context = draft.context
        recipientID = draft.recipient; cardType = draft.kind; priority = draft.priority; attachmentURL = draft.attachment
        isReviewing = true
        errorMessage = String(localized: "Your workspace could not accept this request. Your draft is restored for review.")
        lastQueuedDraft = nil
    }

    var hasDraft: Bool { !sourceText.isEmpty || !title.isEmpty || attachmentURL != nil }
    var canReview: Bool { !sourceText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isDrafting && !isSending }
    var canSend: Bool { !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !recipientID.isEmpty && !isSending && !isDrafting }

    func bind(to appState: AppState) {
        let scope = "\(appState.currentUser?.id ?? "")|\(appState.currentUser?.teamID ?? "")|\(appState.isGuest)|\(appState.activeSessionID)"
        if boundScope != scope { reset(); boundScope = scope }
    }

    func reset() {
        generation = UUID()
        lastQueuedDraft = nil
        sourceText = ""; title = ""; summary = ""; context = ""; recipientID = ""
        cardType = .approval; priority = .medium; isReviewing = false
        isDrafting = false; isSending = false; errorMessage = nil; preparationNote = nil; attachmentURL = nil
    }

    func useCapture(text: String, video: URL?) {
        sourceText = [sourceText, text].filter { !$0.isEmpty }.joined(separator: "\n")
        if let video { attachmentURL = MediaStore.keep(video) ?? video }
    }

    func teamChanged() {
        generation = UUID(); recipientID = ""; isDrafting = false
        lastQueuedDraft = nil
    }

    func removeAttachment() { attachmentURL = nil }

    func prepare(appState: AppState) async {
        guard canReview, let user = appState.currentUser else { return }
        let operation = generation
        let session = appState.activeSessionID
        let selectedRecipient = appState.workspaceMembers.contains(where: { $0.id == recipientID }) ? recipientID : ""
        let selectedType = cardType
        let text = sourceText.trimmingCharacters(in: .whitespacesAndNewlines)
        let manual = OfflineRouter.draft(text: text, sender: user, priority: priority, recipientUserID: selectedRecipient.isEmpty ? nil : selectedRecipient)
        title = manual.title; summary = manual.summary; context = ""
        errorMessage = nil; preparationNote = nil
        isDrafting = true
        if appState.isGuest {
            preparationNote = String(localized: "Demo draft · your words stay on this device")
        } else if appState.connectionState != .connected || !appState.aiService.hasRelay {
            preparationNote = String(localized: "Manual draft · reconnect before sending")
        } else {
            do {
                let draft = try await appState.aiService.draftInstruction(text: text, sender: user, organization: appState.organization, priorityOverride: nil, readerLanguage: appState.readerLanguageCode, senderContext: appState.userContext, recipientUserID: selectedRecipient.isEmpty ? nil : selectedRecipient)
                guard generation == operation, appState.activeSessionID == session, appState.currentUser == user else { return }
                if !selectedRecipient.isEmpty && draft.recipientUserID != selectedRecipient { throw AIServiceError.invalidResponse }
                if selectedRecipient.isEmpty, appState.workspaceMembers.contains(where: { $0.id == draft.recipientUserID }) { recipientID = draft.recipientUserID }
                cardType = draft.cardType; priority = draft.priority
                title = draft.title; summary = draft.summary; context = draft.context
                preparationNote = draft.quotaExceeded ? String(localized: "AI limit reached. Review this manual draft before sending.") : String(localized: "Review every detail before sending.")
            } catch {
                guard generation == operation, appState.activeSessionID == session, appState.currentUser == user else { return }
                preparationNote = String(localized: "AI could not prepare this request. Your text is kept below; edit it and send when ready.")
            }
        }
        guard generation == operation, appState.activeSessionID == session, appState.currentUser == user else { return }
        if appState.isGuest { cardType = selectedType }
        if !selectedRecipient.isEmpty { recipientID = selectedRecipient }
        isDrafting = false
        isReviewing = true
    }

    func send(appState: AppState) async -> DecisionCard? {
        if let validationMessage { errorMessage = validationMessage; return nil }
        guard canSend, let user = appState.currentUser else { return nil }
        let operation = generation
        let session = appState.activeSessionID
        guard appState.isGuest || appState.connectionState == .connected else {
            errorMessage = String(localized: "Connect to your workspace before sending. Your draft is kept here.")
            return nil
        }
        guard appState.workspaceMembers.contains(where: { $0.id == recipientID }) else {
            errorMessage = String(localized: "Choose someone in this workspace.")
            return nil
        }
        isSending = true; errorMessage = nil
        if !appState.isGuest { appState.webSocketService.clearDeliveryError() }
        do {
            var videoURL: String?
            if let attachmentURL {
                if appState.isGuest { videoURL = attachmentURL.absoluteString }
                else {
                    guard let base = appState.backendBaseURL else { throw CardServiceError.notConnected }
                    let compressed = await MediaStore.compress(attachmentURL)
                    guard generation == operation, appState.activeSessionID == session, appState.currentUser == user else { throw CancellationError() }
                    videoURL = try await MediaUploader.upload(compressed, to: base)
                    guard generation == operation, appState.activeSessionID == session, appState.currentUser == user else { throw CancellationError() }
                }
            }
            let routing = InstructionRouting(recipientID: recipientID, cardType: cardType, title: title.trimmingCharacters(in: .whitespacesAndNewlines), summary: summary.trimmingCharacters(in: .whitespacesAndNewlines), context: context.trimmingCharacters(in: .whitespacesAndNewlines), priority: priority, agentRoute: "", routingReason: String(localized: "Selected by you"), labels: [], toolCalls: [])
            let sent = try await appState.cardService.processRouting(routing, sourceText: sourceText, from: user, videoURL: videoURL)
            guard generation == operation, appState.activeSessionID == session, appState.currentUser == user else { return nil }
            if !appState.isGuest, let message = appState.webSocketService.deliveryError {
                errorMessage = message; isSending = false; return nil
            }
            let preserved = (cardID: sent.id, sessionID: session, source: sourceText, title: title, summary: summary, context: context, recipient: recipientID, kind: cardType, priority: priority, attachment: attachmentURL)
            reset()
            if !appState.isGuest { lastQueuedDraft = preserved }
            return sent
        } catch {
            guard generation == operation, appState.activeSessionID == session, appState.currentUser == user else { return nil }
            errorMessage = error.localizedDescription
            isSending = false
            return nil
        }
    }
}
