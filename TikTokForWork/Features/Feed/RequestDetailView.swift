import SwiftUI

struct RequestDetailView: View {
    let cardID: String
    @ObservedObject var service: DecisionCardService
    @EnvironmentObject private var appState: AppState
    @ScaledMetric(relativeTo: .title2) private var headingSize = 26.0
    @State private var isWorking = false
    @State private var error: String?
    @State private var noteAction: CardActionKind?
    @State private var note = ""
    @State private var showNote = false
    @State private var showDelegate = false
    @State private var confirmDecline = false
    @State private var confirmUndo = false

    private var card: DecisionCard? { service.card(id: cardID) }
    private var canAct: Bool { appState.isGuest || appState.connectionState == .connected }
    var body: some View {
        Group {
            if let card {
                ScrollView {
                    VStack(alignment: .leading, spacing: 26) {
                        VStack(alignment: .leading, spacing: 15) {
                            HStack(spacing: 8) {
                                Text(card.type.label).font(.caption.weight(.semibold))
                                    .padding(.horizontal, 10).padding(.vertical, 6)
                                    .background(Theme.Colors.surfaceRaised, in: Capsule())
                                Text(card.priorityLabel).font(.caption.weight(.medium)).foregroundStyle(card.priority == .urgent ? Theme.Colors.reject : Theme.Colors.textSecondary)
                                Spacer()
                                if appState.isGuest { Text("Sample data").font(.caption).foregroundStyle(Theme.Colors.accent) }
                            }
                            Text(card.title).font(.system(size: headingSize, weight: .bold)).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
                            HStack(spacing: 8) {
                                Text(String(name(card.senderUserID).prefix(1))).font(.subheadline.weight(.semibold))
                                    .foregroundStyle(Theme.Colors.accent).frame(width: 34, height: 34)
                                    .background(Theme.Colors.accent.opacity(0.1), in: Circle())
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(name(card.senderUserID)).font(.subheadline.weight(.medium))
                                    Text(card.createdAt, format: .dateTime.month(.abbreviated).day().hour().minute())
                                        .font(.caption).foregroundStyle(Theme.Colors.textSecondary)
                                }
                                Spacer()
                            }
                        }
                        Text(card.summary).font(.body).lineSpacing(6).fixedSize(horizontal: false, vertical: true)
                        if !card.context.isEmpty { section("Context", text: card.context) }
                        if let source = card.sourceApp {
                            VStack(alignment: .leading, spacing: 9) {
                                Text(appState.isGuest ? String(localized: "Sample source") : String(localized: "Source")).font(.subheadline.weight(.semibold))
                                Label([source.capitalized, card.sourceDetail].compactMap { $0 }.joined(separator: " · "), systemImage: "link")
                                    .font(.subheadline).foregroundStyle(Theme.Colors.textSecondary)
                            }
                        }
                        if let original = card.sourceInstruction, !original.isEmpty, original != card.summary { section("Original request", text: original) }
                        if let videoURL = card.videoURL { CardVideoView(urlString: videoURL) }
                        if service.awaitingDeliveryIDs.contains(card.id) {
                            Label("Waiting for workspace sync", systemImage: "arrow.triangle.2.circlepath").font(.subheadline).foregroundStyle(Theme.Colors.textSecondary)
                        }
                        if !card.isPending {
                            VStack(alignment: .leading, spacing: 12) {
                                Label(card.status.label, systemImage: "checkmark.circle.fill").font(.headline).foregroundStyle(Theme.Colors.approve)
                                if let reply = card.decision?.replyText { Text(reply).font(.body) }
                                if let note = card.decision?.note, !note.isEmpty { Text(note).font(.body) }
                                if let decision = card.decision {
                                    Text(decision.decidedAt, format: .dateTime.month(.abbreviated).day().hour().minute()).font(.caption).foregroundStyle(Theme.Colors.textSecondary)
                                }
                                if appState.isGuest { Text("Saved in this demo only").font(.caption).foregroundStyle(Theme.Colors.textSecondary) }
                                if let urlString = card.githubIssueURL, let url = URL(string: urlString) {
                                    Link("Open GitHub issue", destination: url).font(.subheadline.weight(.medium))
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading).padding(18)
                            .background(Theme.Colors.surface, in: RoundedRectangle(cornerRadius: 14))
                        }
                        if card.isPending && card.senderUserID == appState.currentUser?.id && card.recipientUserID != appState.currentUser?.id {
                            Label(String(localized: "Waiting for \(name(card.recipientUserID))"), systemImage: "clock").font(.subheadline).foregroundStyle(Theme.Colors.textSecondary)
                        }
                    }.padding(24)
                }
                .background(Theme.Colors.background)
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    if card.recipientUserID == appState.currentUser?.id { actions(card) }
                }
            } else { ContentUnavailableView("Request unavailable", systemImage: "doc.questionmark") }
        }
        .navigationTitle("Request")
        .navigationBarTitleDisplayMode(.inline)
        .alert("Could not update request", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK") { error = nil }
        } message: { Text(error ?? "") }
        .confirmationDialog("Decline this request?", isPresented: $confirmDecline, titleVisibility: .visible) {
            Button("Decline", role: .destructive) { run(.reject) }
        }
        .confirmationDialog("Undo this decision?", isPresented: $confirmUndo, titleVisibility: .visible) {
            Button("Undo decision") { undo() }
        } message: { Text("This reopens the request. Changes already made in GitHub will remain.") }
        .sheet(isPresented: $showNote) { noteSheet }
        .sheet(isPresented: $showDelegate) { delegateSheet }
    }

    private func section(_ title: LocalizedStringKey, text: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.subheadline.weight(.semibold))
            Text(text).font(.body).foregroundStyle(Theme.Colors.textSecondary).lineSpacing(5).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func actions(_ card: DecisionCard) -> some View {
        VStack(spacing: 10) {
            if !canAct { Text("Reconnect to respond. Your request stays here.").font(.caption).foregroundStyle(Theme.Colors.textSecondary) }
            if card.isPending {
                if !appState.isGuest && card.type == .approval && appState.githubService.isConnected {
                    Text("Approving creates a GitHub issue in this workspace.").font(.caption).foregroundStyle(Theme.Colors.textSecondary)
                }
                HStack(spacing: 12) {
                    Menu {
                        Button("Reply", systemImage: "arrowshape.turn.up.left") { openNote(.reply) }
                        Button("Request revision", systemImage: "pencil") { openNote(.requestRevision) }
                        Button("Delegate", systemImage: "person.badge.plus") { showDelegate = true }
                        Button("Decline", systemImage: "xmark", role: .destructive) { confirmDecline = true }
                    } label: {
                        Image(systemName: "ellipsis").font(.headline).frame(width: 52, height: 52)
                            .background(Theme.Colors.surfaceRaised, in: RoundedRectangle(cornerRadius: 14))
                    }.accessibilityLabel("More actions")
                    PrimaryButton(title: primaryTitle(card), enabled: canAct && !isWorking) {
                        if card.type == .revision { openNote(.reply) }
                        else { run(card.type == .approval ? .createIssue : .acknowledge) }
                    }
                }.disabled(isWorking || !canAct)
            } else {
                Button { if card.githubIssueNumber != nil { confirmUndo = true } else { undo() } } label: {
                    Label("Undo decision", systemImage: "arrow.uturn.backward").font(.subheadline.weight(.semibold)).frame(maxWidth: .infinity, minHeight: 44)
                }.disabled(isWorking || !canAct)
            }
            if isWorking { ProgressView().controlSize(.small) }
        }
        .padding(.horizontal, 24).padding(.vertical, 12)
        .background(Theme.Colors.background.shadow(color: .black.opacity(0.04), radius: 8, y: -4))
        .overlay(alignment: .top) { Divider() }
    }

    private func primaryTitle(_ card: DecisionCard) -> String {
        switch card.type {
        case .approval: String(localized: "Approve")
        case .task, .delegation: String(localized: "Mark complete")
        case .notification: String(localized: "Acknowledge")
        case .revision: String(localized: "Reply")
        }
    }
    private func name(_ id: String) -> String { appState.workspaceMembers.first { $0.id == id }?.name ?? DisplayName.of(id, in: appState.organization) }
    private func openNote(_ action: CardActionKind) { noteAction = action; note = ""; showNote = true }
    private var noteSheet: some View {
        NavigationStack {
            Form {
                Section { Text(card?.title ?? "").font(.headline) }
                Section {
                    TextEditor(text: $note).frame(minHeight: 160)
                } header: {
                    Text(noteAction == .reply ? String(localized: "Your reply") : String(localized: "What needs to change?"))
                } footer: {
                    Text(appState.isGuest ? String(localized: "This action stays in the demo. Nobody will be notified.") : (noteAction == .reply ? String(localized: "Sending a reply completes this request and notifies the sender.") : String(localized: "The sender will receive your revision request.")))
                }
            }
            .navigationTitle(noteAction == .reply ? String(localized: "Reply") : String(localized: "Request revision"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { showNote = false } }
                ToolbarItem(placement: .confirmationAction) { Button("Send") { showNote = false; run(noteAction ?? .reply, text: note) }.disabled(note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
            }
        }
    }
    private var delegateSheet: some View {
        NavigationStack {
            List(appState.workspaceMembers.filter { $0.id != appState.currentUser?.id }) { member in
                Button { showDelegate = false; delegate(to: member.id) } label: {
                    VStack(alignment: .leading, spacing: 4) { Text(member.name).foregroundStyle(Theme.Colors.textPrimary); Text(member.role).font(.caption).foregroundStyle(Theme.Colors.textSecondary) }
                }
            }.navigationTitle("Delegate to").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { showDelegate = false } } }
                .task { await appState.refreshWorkspaceMembers() }
        }
    }
    private func run(_ action: CardActionKind, text: String? = nil) {
        guard let userID = appState.currentUser?.id else { return }
        isWorking = true
        Task {
            do {
                _ = try await service.resolve(cardID: cardID, action: action, actorUserID: userID, revisionNote: action == .requestRevision ? text : nil, replyText: action == .reply ? text : nil, githubService: appState.githubService)
                Haptics.success()
            } catch { self.error = error.localizedDescription }
            isWorking = false
        }
    }
    private func undo() {
        guard let userID = appState.currentUser?.id else { return }
        isWorking = true
        Task {
            do { try await service.undo(cardID: cardID, actorUserID: userID) } catch { self.error = error.localizedDescription }
            isWorking = false
        }
    }
    private func delegate(to id: String) {
        guard let userID = appState.currentUser?.id else { return }
        isWorking = true
        Task {
            do { _ = try await service.delegate(cardID: cardID, to: id, actorUserID: userID, organization: appState.organization, githubService: appState.githubService) }
            catch { self.error = error.localizedDescription }
            isWorking = false
        }
    }
}
