import SwiftUI

struct FeedView: View {
    /// Cards (false) or the Slack-style list (true), switched in the header.
    @Binding var list: Bool
    var onProfile: () -> Void = {}
    @EnvironmentObject private var appState: AppState
    var body: some View { CardHomeContent(service: appState.cardService, list: $list, onProfile: onProfile) }
}

/// Home's header, the same over Cards and the list: the workspace on
/// Slack's aubergine band (its mark switches workspaces), how you read
/// Home, search when there is something to search, and you.
struct HomeHeader: View {
    @ObservedObject var service: DecisionCardService
    @Binding var list: Bool
    var onSearch: (() -> Void)? = nil
    let onProfile: () -> Void
    @EnvironmentObject private var appState: AppState

    private var waiting: Int { service.cards(for: appState.currentUser?.id ?? "").filter(\.isPending).count }

    var body: some View {
        VStack(spacing: 12) {
            HStack(spacing: 12) {
                WorkspaceSwitcherButton(size: 36)
                Text(verbatim: appState.workspaceDisplayName)
                    .font(.title3.weight(.bold)).foregroundStyle(.white)
                    .lineLimit(1).minimumScaleFactor(0.8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let onSearch {
                    Button(action: onSearch) {
                        Image(systemName: "magnifyingglass").font(.system(size: 18, weight: .semibold)).foregroundStyle(.white)
                            .frame(width: 40, height: 40)
                    }.buttonStyle(.plain).accessibilityLabel("Search messages")
                }
                Button(action: onProfile) {
                    RequestAvatar(name: appState.currentUser?.name ?? "?", url: appState.workspaceMembers.first { $0.id == appState.currentUser?.id }?.avatarUrl, size: 32)
                        .overlay(Circle().stroke(.white.opacity(0.55), lineWidth: 1))
                        .frame(width: 40, height: 40)
                }.buttonStyle(.plain).accessibilityLabel("Profile")
            }
            HStack(spacing: 0) {
                segment(on: !list, action: { list = false }) {
                    HStack(spacing: 6) {
                        Text("Cards")
                        if waiting > 0 {
                            Text(verbatim: "\(waiting)").font(.system(size: 11, weight: .bold))
                                .foregroundStyle(list ? Color.white : Color(hex: 0x2B154B))
                                .frame(minWidth: 18, minHeight: 18)
                                .background(list ? Color.white.opacity(0.25) : Color.white, in: Circle())
                        }
                    }
                }
                segment(on: list, action: { list = true }) { Text("Classic") }
            }
            .padding(3)
            .background(Color.white.opacity(0.12), in: Capsule())
        }
        .padding(.horizontal, 16).padding(.top, 4).padding(.bottom, 12)
        .background(Color(hex: 0x2B154B).ignoresSafeArea(edges: .top))
    }

    private func segment<L: View>(on: Bool, action: @escaping () -> Void, @ViewBuilder label: () -> L) -> some View {
        Button { action(); Haptics.light() } label: {
            label()
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(on ? Color(hex: 0x2B154B) : Color.white.opacity(0.85))
                .frame(maxWidth: .infinity, minHeight: 32)
                .background(on ? Color.white : Color.clear, in: Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

private struct CardHomeContent: View {
    @ObservedObject var service: DecisionCardService
    @Binding var list: Bool
    let onProfile: () -> Void
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var push: PushService
    @Environment(\.scenePhase) private var scenePhase
    @State private var selectedID: String?
    @State private var detailCard: DecisionCard?
    @State private var noteCard: DecisionCard?
    @State private var noteAction: CardActionKind = .reply
    @State private var note = ""
    @State private var delegateCard: DecisionCard?
    @State private var pendingAction: CardActionKind?
    @State private var confirmationCard: DecisionCard?
    @State private var showConfirmation = false
    @State private var isWorking = false
    @State private var error: String?
    @State private var lastDecision: DecisionCard?
    @State private var confirmUndo = false
    @State private var isRecoveringSession = false
    @State private var deleteCard: DecisionCard?
    @State private var suggestRule: (cardID: String, sender: String, business: String?)?
    private var cards: [DecisionCard] { service.cards(for: appState.currentUser?.id ?? "").filter(\.isPending) }
    /// The feed on screen: every app's card in it has been seen, so the icon
    /// stops counting them, here and on the web.
    private func markAppsSeen() {
        guard scenePhase == .active, !appState.isGuest else { return }
        AppReads.shared.seen(cards, orgId: appState.currentUser?.teamID, base: appState.backendBaseURL)
    }
    private var selectedCard: DecisionCard? { cards.first { $0.id == selectedID } ?? cards.first }

    var body: some View {
        VStack(spacing: 0) {
            HomeHeader(service: service, list: $list, onProfile: onProfile)
            if cards.isEmpty { emptyState }
            else {
                TabView(selection: $selectedID) {
                    ForEach(cards) { card in
                        VStack(spacing: 0) {
                            ScrollView {
                                DecisionCardView(card: card, linkedRepository: appState.githubService.linkedRepository, isGitHubConnected: !appState.isGuest && appState.githubService.isConnected, showsActions: false, onAction: { handle($0, card: card) }, onShowDetails: { detailCard = card },
                                                 onSetPriority: appState.isGuest || !card.isPending ? nil : { level in Task { await appState.webSocketService.setPriority(cardID: card.id, priority: level) } })
                                    .disabled(isWorking).padding(.horizontal, 20).padding(.top, 4).padding(.bottom, 8)
                            }
                            if card.awaitsPost {
                                // Not decided: read, changed and posted.
                                PrimaryButton(title: String(localized: "Review and post")) { detailCard = card }
                                    .padding(.horizontal, 24).padding(.top, 12).padding(.bottom, 20)
                            } else {
                                DecisionCardActions(card: card, onAction: { handle($0, card: card) })
                                    .disabled(isWorking).padding(.top, 12).padding(.bottom, 20)
                            }
                        }.tag(Optional(card.id))
                    }
                }.tabViewStyle(.page(indexDisplayMode: .never))
            }
            if let lastDecision {
                HStack(spacing: 10) {
                    Text(service.awaitingDeliveryIDs.contains(lastDecision.id) ? String(localized: "Waiting for workspace sync") : lastDecision.status.label).font(.footnote)
                    Spacer()
                    Button("Undo") { if lastDecision.githubIssueNumber != nil { confirmUndo = true } else { undo(lastDecision) } }.font(.footnote.weight(.semibold)).disabled(isWorking)
                }.padding(.horizontal, 22).padding(.vertical, 8).background(Theme.Colors.background)
            }
            if !appState.isGuest && appState.connectionState != .connected {
                Text(connectionMessage).font(.caption).foregroundStyle(Theme.Colors.textSecondary).padding(.bottom, 8)
            }
        }
        .background(Theme.Colors.surface)
        .onAppear { selectedID = selectedCard?.id; markAppsSeen() }
        .onChange(of: service.revision) { _, _ in
            if !cards.contains(where: { $0.id == selectedID }) { selectedID = cards.first?.id }
            markAppsSeen()
        }
        .onChange(of: scenePhase) { _, phase in if phase == .active { markAppsSeen() } }
        .onChange(of: push.pendingCardID) { _, id in
            guard let id, let card = service.card(id: id) else { return }
            detailCard = card; push.pendingCardID = nil
        }
        .sheet(item: $detailCard) { card in
            NavigationStack {
                RequestDetailView(cardID: card.id, service: service)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { Button("Close") { detailCard = nil } }
                        if let me = appState.currentUser?.id, card.canBeDeleted(by: me) {
                            ToolbarItem(placement: .primaryAction) {
                                // The question is asked on the feed, once the sheet is down.
                                Button { detailCard = nil; DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { deleteCard = card } } label: { Image(systemName: "trash") }
                                    .accessibilityLabel(Text("Delete card"))
                            }
                        }
                    }
            }
        }
        .sheet(item: $noteCard) { card in noteSheet(card) }
        .sheet(item: $delegateCard) { card in delegateSheet(card) }
        .confirmationDialog(pendingAction == .reject ? String(localized: "Decline this request?") : String(localized: "Approve and create a GitHub issue?"), isPresented: $showConfirmation, titleVisibility: .visible) {
            if let card = confirmationCard, let action = pendingAction {
                Button(action == .reject ? String(localized: "Decline") : String(localized: "Approve"), role: action == .reject ? .destructive : nil) { resolve(card, action: action) }
            }
        } message: {
            if pendingAction == .createIssue { Text(appState.githubService.linkedRepository) }
        }
        .confirmationDialog("Delete this card?", isPresented: Binding(get: { deleteCard != nil }, set: { if !$0 { deleteCard = nil } }), titleVisibility: .visible, presenting: deleteCard) { card in
            Button("Delete card", role: .destructive) { delete(card); deleteCard = nil }
            Button("Cancel", role: .cancel) { deleteCard = nil }
        } message: { card in Text(card.displayTitle) }
        .confirmationDialog("Undo this decision?", isPresented: $confirmUndo, titleVisibility: .visible) {
            if let card = lastDecision { Button("Undo decision") { undo(card) } }
        } message: { Text("This reopens the request. Changes already made in GitHub will remain.") }
        // Waiting cards in the language this person reads, when it changes
        // or a card arrives in another.
        .task(id: "\(appState.language.readerLanguageCode)|\(cards.map(\.id).joined(separator: ","))") {
            guard !appState.isGuest, let base = appState.backendBaseURL, let orgId = appState.currentUser?.teamID else { return }
            await CardLocalizer.request(for: cards, language: appState.language.readerLanguageCode, orgId: orgId, base: base)
        }
        .alert("Could not update request", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK") { error = nil }
        } message: { Text(error ?? "") }
        .alert("Make it a standing yes?", isPresented: Binding(get: { suggestRule != nil && error == nil }, set: { if !$0 { suggestRule = nil } })) {
            Button("Approve automatically") { acceptRule() }
            Button("Not now", role: .cancel) { suggestRule = nil }
        } message: {
            if let r = suggestRule {
                if let b = r.business { Text("Approve \(r.sender)’s requests like this in #\(b) automatically from now on?") }
                else { Text("Approve \(r.sender)’s requests like this automatically from now on?") }
            }
        }
    }

    /// The third yes in a row to the same kind of request from the same
    /// person: offer to make it a standing yes. Asked once per kind.
    private func noteStreak(_ card: DecisionCard, action: CardActionKind) {
        guard !appState.isGuest, let me = appState.currentUser?.id, let org = appState.currentUser?.teamID,
              card.senderUserID != me, !card.senderUserID.isEmpty else { return }
        let kind = "\(org):\(card.senderUserID)|\(card.type.rawValue)|\(card.business ?? "")"
        let defaults = UserDefaults.standard
        guard action == .createIssue else { defaults.removeObject(forKey: "autorule.streak:\(kind)"); return }
        let streak = defaults.integer(forKey: "autorule.streak:\(kind)") + 1
        defaults.set(streak, forKey: "autorule.streak:\(kind)")
        guard streak >= 3, !defaults.bool(forKey: "autorule.asked:\(kind)") else { return }
        defaults.set(true, forKey: "autorule.asked:\(kind)")
        suggestRule = (card.id, card.requestedBy?.name ?? memberName(card.senderUserID), card.business)
    }
    private func acceptRule() {
        guard let r = suggestRule, let org = appState.currentUser?.teamID, let base = appState.backendBaseURL else { suggestRule = nil; return }
        suggestRule = nil
        Task {
            do { try await ChatService.addAutoRule(orgId: org, cardId: r.cardID, base: base); Haptics.success() }
            catch { self.error = String(localized: "That did not save.") }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Spacer()
            if !appState.isGuest && appState.connectionState != .connected {
                Image(systemName: "wifi.exclamationmark").font(.system(size: 42, weight: .light)).foregroundStyle(Theme.Colors.textSecondary)
                Text(connectionMessage).font(.title3.weight(.semibold))
                Button("Try again") {
                    isRecoveringSession = true
                    Task {
                        await appState.restoreSessionIfNeeded()
                        isRecoveringSession = false
                    }
                }.disabled(isRecoveringSession)
                Button("Profile", action: onProfile)
            } else {
                Image(systemName: "checkmark.circle").font(.system(size: 42, weight: .light)).foregroundStyle(Theme.Colors.textSecondary)
                Text("You're all caught up").font(.title3.weight(.semibold))
                Text("New requests from your teammates will appear here.").font(.subheadline).foregroundStyle(Theme.Colors.textSecondary).multilineTextAlignment(.center)
            }
            Spacer()
        }.padding(30)
    }
    private var connectionMessage: String {
        switch appState.connectionState {
        case .connected: ""
        case .connecting: String(localized: "Reconnecting…")
        case .offline: String(localized: "Offline")
        case .refused: String(localized: "No access")
        }
    }
    private func memberName(_ id: String) -> String { appState.workspaceMembers.first { $0.id == id }?.name ?? DisplayName.of(id, in: appState.organization) }
    private func handle(_ action: CardActionKind, card: DecisionCard) {
        if action == .reply || action == .requestRevision { noteAction = action; note = ""; noteCard = card }
        else if action == .delegate { delegateCard = card }
        else if action == .viewDetails { detailCard = card }
        else if action == .delete { deleteCard = card }
        else if action == .reject || (action == .createIssue && !appState.isGuest && appState.githubService.isConnected) {
            pendingAction = action; confirmationCard = card; showConfirmation = true
        } else { resolve(card, action: action) }
    }
    private func resolve(_ card: DecisionCard, action: CardActionKind, text: String? = nil) {
        guard let userID = appState.currentUser?.id else { return }
        isWorking = true
        Task {
            do {
                lastDecision = try await service.resolve(cardID: card.id, action: action, actorUserID: userID, revisionNote: action == .requestRevision ? text : nil, replyText: action == .reply ? text : nil, githubService: appState.githubService)
                Haptics.success()
                noteStreak(card, action: action)
            } catch { self.error = error.localizedDescription }
            isWorking = false
        }
    }
    private func delete(_ card: DecisionCard) {
        guard let userID = appState.currentUser?.id else { return }
        isWorking = true
        Task {
            do { try await service.delete(cardID: card.id, actorUserID: userID); Haptics.success() }
            catch { self.error = error.localizedDescription }
            isWorking = false
        }
    }
    private func undo(_ card: DecisionCard) {
        guard let userID = appState.currentUser?.id else { return }
        isWorking = true
        Task {
            do { try await service.undo(cardID: card.id, actorUserID: userID); selectedID = card.id; lastDecision = nil }
            catch { self.error = error.localizedDescription }
            isWorking = false
        }
    }
    private func noteSheet(_ card: DecisionCard) -> some View {
        NavigationStack {
            Form {
                Section { Text(card.displayTitle).font(.headline) }
                Section { TextEditor(text: $note).frame(minHeight: 140) } footer: {
                    Text(appState.isGuest ? String(localized: "This action stays in the demo. Nobody will be notified.") : (noteAction == .reply ? String(localized: "Sending a reply completes this request and notifies the sender.") : String(localized: "The sender will receive your revision request.")))
                }
            }
            .navigationTitle(noteAction == .reply ? String(localized: "Reply") : String(localized: "Request revision"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { noteCard = nil } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") { resolve(card, action: noteAction, text: note); noteCard = nil }.disabled(note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
    private func delegateSheet(_ card: DecisionCard) -> some View {
        NavigationStack {
            List(appState.workspaceMembers.filter { $0.id != appState.currentUser?.id }) { member in
                Button(member.name) {
                    delegateCard = nil; isWorking = true
                    Task {
                        do { lastDecision = try await service.delegate(cardID: card.id, to: member.id, actorUserID: appState.currentUser?.id ?? "", organization: appState.organization, githubService: appState.githubService) }
                        catch { self.error = error.localizedDescription }
                        isWorking = false
                    }
                }
            }.navigationTitle("Delegate to").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { delegateCard = nil } } }
        }
    }
}
