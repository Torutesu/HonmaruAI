import SwiftUI

struct FeedView: View {
    var onProfile: () -> Void = {}
    var onComposeToMember: (String) -> Void = { _ in }
    @EnvironmentObject private var appState: AppState
    var body: some View { CardHomeContent(service: appState.cardService, onProfile: onProfile, onComposeToMember: onComposeToMember) }
}

private struct CardHomeContent: View {
    @ObservedObject var service: DecisionCardService
    let onProfile: () -> Void
    let onComposeToMember: (String) -> Void
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var push: PushService
    @State private var classic = false
    @State private var selectedID: String?
    @State private var search = ""
    @State private var highPriorityOnly = false
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
    private var cards: [DecisionCard] { service.cards(for: appState.currentUser?.id ?? "").filter(\.isPending) }
    private var selectedCard: DecisionCard? { cards.first { $0.id == selectedID } ?? cards.first }
    private var filtered: [DecisionCard] {
        cards.filter { card in (!highPriorityOnly || card.priority == .high || card.priority == .urgent) && (search.isEmpty || [card.title, card.summary, memberName(card.senderUserID)].joined(separator: " ").localizedCaseInsensitiveContains(search)) }
    }

    var body: some View {
        VStack(spacing: 0) {
            if classic { classicWorkspaceHeader }
            header
            if classic { classicList }
            else if cards.isEmpty { emptyState }
            else {
                TabView(selection: $selectedID) {
                    ForEach(cards) { card in
                        VStack(spacing: 0) {
                            ScrollView {
                                DecisionCardView(card: card, linkedRepository: appState.githubService.linkedRepository, isGitHubConnected: !appState.isGuest && appState.githubService.isConnected, showsActions: false, onAction: { handle($0, card: card) }, onShowDetails: { detailCard = card })
                                    .disabled(isWorking).padding(.horizontal, 20).padding(.top, 4).padding(.bottom, 8)
                            }
                            DecisionCardActions(card: card, onAction: { handle($0, card: card) })
                                .disabled(isWorking).padding(.top, 12).padding(.bottom, 20)
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
        .onAppear { selectedID = selectedCard?.id }
        .onChange(of: service.revision) { _, _ in if !cards.contains(where: { $0.id == selectedID }) { selectedID = cards.first?.id } }
        .onChange(of: push.pendingCardID) { _, id in
            guard let id, let card = service.card(id: id) else { return }
            detailCard = card; push.pendingCardID = nil
        }
        .sheet(item: $detailCard) { card in
            NavigationStack {
                RequestDetailView(cardID: card.id, service: service)
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { detailCard = nil } } }
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
        .confirmationDialog("Undo this decision?", isPresented: $confirmUndo, titleVisibility: .visible) {
            if let card = lastDecision { Button("Undo decision") { undo(card) } }
        } message: { Text("This reopens the request. Changes already made in GitHub will remain.") }
        .alert("Could not update request", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK") { error = nil }
        } message: { Text(error ?? "") }
    }

    private var header: some View {
        HStack {
            HStack(spacing: 0) {
                Button { classic = false } label: {
                    HStack(spacing: 6) {
                        Text("Cards").font(.system(size: 13, weight: .medium))
                        Text("\(cards.count)").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.Colors.ctaText)
                            .frame(minWidth: 20, minHeight: 20).background(Theme.Colors.ctaFill, in: Circle())
                    }.padding(.horizontal, 10).frame(minHeight: 34)
                        .background(!classic ? Theme.Colors.background : Color.clear, in: Capsule())
                }
                Button { classic = true } label: {
                    Text("Classic").font(.system(size: 13, weight: .medium)).padding(.horizontal, 12).frame(minHeight: 34)
                        .foregroundStyle(classic ? Theme.Colors.textPrimary : Theme.Colors.textSecondary)
                        .background(classic ? Theme.Colors.background : Color.clear, in: Capsule())
                }
            }.padding(4).background(Theme.Colors.surfaceRaised, in: Capsule()).buttonStyle(.plain)
            Spacer()
            if !classic {
                Button(action: onProfile) {
                    RequestAvatar(name: appState.currentUser?.name ?? "?", url: appState.workspaceMembers.first { $0.id == appState.currentUser?.id }?.avatarUrl, size: 38)
                }.buttonStyle(.plain).accessibilityLabel("Profile")
            }
        }
        .foregroundStyle(Theme.Colors.textPrimary)
        .padding(.horizontal, 20).padding(.top, 6).padding(.bottom, 12)
    }

    private var classicWorkspaceHeader: some View {
        HStack(spacing: 10) {
            AppLogo(size: 24)
                .padding(4).background(.white, in: RoundedRectangle(cornerRadius: 6))
            Text(appState.workspaceDisplayName)
                .font(.subheadline.weight(.semibold)).foregroundStyle(.white)
                .lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
            Button(action: onProfile) {
                RequestAvatar(name: appState.currentUser?.name ?? "?", url: appState.workspaceMembers.first { $0.id == appState.currentUser?.id }?.avatarUrl, size: 30)
                    .overlay(Circle().stroke(.white.opacity(0.6), lineWidth: 1))
                    .frame(width: 44, height: 44)
            }.buttonStyle(.plain).accessibilityLabel("Profile")
        }
        .padding(.horizontal, 20).padding(.vertical, 6)
        .background(Color(hex: 0x2B154B))
        .padding(.bottom, 6)
    }

    private var classicList: some View {
        VStack(spacing: 8) {
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass").foregroundStyle(Theme.Colors.textSecondary)
                TextField("Search requests or people", text: $search).font(.subheadline)
                Button { highPriorityOnly.toggle() } label: { Image(systemName: "slider.horizontal.3") }
                    .foregroundStyle(highPriorityOnly ? Theme.Colors.accent : Theme.Colors.textSecondary).accessibilityLabel("High priority")
            }.padding(12).background(Theme.Colors.background, in: RoundedRectangle(cornerRadius: 8)).overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.Colors.border)).padding(.horizontal, 20)
            List {
                Section(appState.isGuest ? String(localized: "Sample requests") : String(localized: "Requests")) {
                    ForEach(filtered) { card in
                        Button { detailCard = card } label: {
                            HStack(spacing: 10) {
                                Image(systemName: "number").font(.title3).foregroundStyle(Theme.Colors.accent).frame(width: 36, height: 36).background(Theme.Colors.accent.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(card.title).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.Colors.textPrimary).lineLimit(1)
                                    Text(card.summary).font(.caption).foregroundStyle(Theme.Colors.textSecondary).lineLimit(1)
                                }
                            }.padding(.vertical, 4)
                        }
                    }
                    if filtered.isEmpty { Text("No matching requests").font(.subheadline).foregroundStyle(Theme.Colors.textSecondary) }
                }
                Section("Teammates") {
                    ForEach(appState.workspaceMembers.filter { $0.id != appState.currentUser?.id }) { member in
                        Button { onComposeToMember(member.id) } label: {
                            HStack(spacing: 10) {
                                RequestAvatar(name: member.name, url: member.avatarUrl, size: 32)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(member.name).font(.subheadline.weight(.medium)).foregroundStyle(Theme.Colors.textPrimary)
                                    Text(member.role).font(.caption).foregroundStyle(Theme.Colors.textSecondary)
                                }
                            }.padding(.vertical, 3)
                        }
                    }
                }
            }.listStyle(.plain).scrollContentBackground(.hidden)
        }
    }
    private var emptyState: some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: "checkmark.circle").font(.system(size: 42, weight: .light)).foregroundStyle(Theme.Colors.textSecondary)
            Text("You're all caught up").font(.title3.weight(.semibold))
            Text("New requests from your teammates will appear here.").font(.subheadline).foregroundStyle(Theme.Colors.textSecondary).multilineTextAlignment(.center)
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
            } catch { self.error = error.localizedDescription }
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
                Section { Text(card.title).font(.headline) }
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
