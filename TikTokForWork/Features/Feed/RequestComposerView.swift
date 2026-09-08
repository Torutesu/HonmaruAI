import SwiftUI

struct RequestComposerView: View {
    @ObservedObject var model: FeedViewModel
    let onSent: (DecisionCard) -> Void
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var captureMode: CaptureMode?
    @State private var confirmDiscard = false
    @FocusState private var writing: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    if appState.isGuest {
                        Label("Demo workspace · sample data only", systemImage: "square.stack.3d.up")
                            .font(.footnote).foregroundStyle(Theme.Colors.accent)
                    }
                    if model.isReviewing { reviewFields } else { writeFields }
                    recipientPicker
                    HStack(spacing: 16) {
                        VStack(alignment: .leading, spacing: 9) {
                            fieldLabel("Request type")
                            Picker("Request type", selection: $model.cardType) {
                                ForEach(CardType.allCases, id: \.self) { type in Text(type.label).tag(type) }
                            }.pickerStyle(.menu).frame(maxWidth: .infinity, alignment: .leading)
                        }
                        VStack(alignment: .leading, spacing: 9) {
                            fieldLabel("Priority")
                            Picker("Priority", selection: $model.priority) {
                                ForEach(CardPriority.allCases, id: \.self) { priority in Text(priorityLabel(priority)).tag(priority) }
                            }.pickerStyle(.menu).frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .padding(16).background(Theme.Colors.surface, in: RoundedRectangle(cornerRadius: 12))
                    if let url = model.attachmentURL {
                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                Label("Video attached", systemImage: "video").font(.subheadline.weight(.medium))
                                Spacer()
                                Button("Remove") { model.removeAttachment() }.font(.subheadline)
                            }
                            CardVideoView(urlString: url.absoluteString)
                        }
                    }
                    if let error = model.validationMessage ?? model.errorMessage {
                        Label(error, systemImage: "exclamationmark.circle").font(.subheadline).foregroundStyle(Theme.Colors.reject)
                    }
                    if model.isReviewing {
                        Text(appState.isGuest ? String(localized: "This creates a local sample request. Nobody will be notified.") : String(localized: "The recipient will receive this request in their inbox. You can follow it in Sent."))
                            .font(.footnote).foregroundStyle(Theme.Colors.textSecondary)
                    }
                }
                .padding(24)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.Colors.background)
            .navigationTitle(model.isReviewing ? String(localized: "Review request") : String(localized: "New request"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if model.isReviewing { Button("Back") { model.isReviewing = false } }
                    else { Button("Close") { dismiss() } }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if model.hasDraft { Button("Discard", role: .destructive) { confirmDiscard = true } }
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 9) {
                    if model.isDrafting || model.isSending {
                        HStack(spacing: 8) { ProgressView().controlSize(.small); Text(model.isSending ? String(localized: "Sending request…") : String(localized: "Preparing your draft…")).font(.footnote) }
                    }
                    PrimaryButton(title: model.isReviewing ? String(localized: "Send request") : String(localized: "Review request"), enabled: model.isReviewing ? canSend : model.canReview) {
                        writing = false
                        Task {
                            if model.isReviewing { if let card = await model.send(appState: appState) { onSent(card) } }
                            else { await model.prepare(appState: appState) }
                        }
                    }
                    if !model.isReviewing { Text("Nothing is sent until you confirm.").font(.caption).foregroundStyle(Theme.Colors.textSecondary) }
                }
                .padding(.horizontal, 24).padding(.top, 12).padding(.bottom, 12)
                .background(Theme.Colors.background).overlay(alignment: .top) { Divider() }
            }
            .disabled(model.isSending || model.isDrafting)
            .confirmationDialog("Discard this draft?", isPresented: $confirmDiscard, titleVisibility: .visible) {
                Button("Discard draft", role: .destructive) { model.reset(); dismiss() }
                Button("Keep editing", role: .cancel) {}
            }
            .fullScreenCover(item: $captureMode) { mode in
                CaptureView(mode: mode) { text, video in model.useCapture(text: text, video: video) }
            }
            .task { await appState.refreshWorkspaceMembers() }
        }
        .interactiveDismissDisabled(model.isSending || model.isDrafting)
        .tint(Theme.Colors.accent)
    }

    private var canSend: Bool { model.canSend && model.validationMessage == nil && (appState.isGuest || appState.connectionState == .connected) }

    private var writeFields: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("What do you need from your teammate?").font(.title3.weight(.semibold))
            Text("Describe the request, the context, and when you need a response.").font(.subheadline).foregroundStyle(Theme.Colors.textSecondary)
            ZStack(alignment: .topLeading) {
                TextEditor(text: $model.sourceText).font(.body).frame(minHeight: 150).focused($writing).scrollContentBackground(.hidden)
                    .padding(10).accessibilityLabel("Request description")
                if model.sourceText.isEmpty {
                    Text("For example: Please review the launch copy before Friday. We need approval on the headline and customer quote.")
                        .font(.body).foregroundStyle(Theme.Colors.textTertiary).padding(15).allowsHitTesting(false)
                }
            }
            .background(Theme.Colors.surface, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.Colors.border, lineWidth: 1))
            HStack(spacing: 20) {
                Button { writing = false; captureMode = .dictation } label: { Label("Dictate", systemImage: "mic") }
                Button { writing = false; captureMode = .video } label: { Label("Record video", systemImage: "video") }
            }.font(.subheadline.weight(.medium)).frame(minHeight: 36)
        }
    }

    private var reviewFields: some View {
        VStack(alignment: .leading, spacing: 20) {
            if let note = model.preparationNote {
                Label(note, systemImage: "square.and.pencil").font(.footnote).foregroundStyle(Theme.Colors.textSecondary)
            }
            VStack(alignment: .leading, spacing: 9) {
                fieldLabel("Title")
                TextField("Give the request a clear title", text: $model.title, axis: .vertical)
                    .font(.title3.weight(.semibold)).padding(14)
                    .background(Theme.Colors.surface, in: RoundedRectangle(cornerRadius: 10))
            }
            VStack(alignment: .leading, spacing: 9) {
                fieldLabel("Summary")
                TextEditor(text: $model.summary).font(.body).frame(minHeight: 110).scrollContentBackground(.hidden)
                    .padding(10).background(Theme.Colors.surface, in: RoundedRectangle(cornerRadius: 10)).accessibilityLabel("Summary")
            }
            VStack(alignment: .leading, spacing: 9) {
                fieldLabel("Context · optional")
                TextField("Add details or links", text: $model.context, axis: .vertical).font(.body)
                    .lineLimit(3...6).padding(14).background(Theme.Colors.surface, in: RoundedRectangle(cornerRadius: 10))
            }
        }
    }

    private var recipientPicker: some View {
        VStack(alignment: .leading, spacing: 10) {
            fieldLabel("Send to")
            Menu {
                ForEach(appState.workspaceMembers) { member in
                    Button { model.recipientID = member.id } label: { Text("\(member.name) · \(member.role)") }
                }
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "person.crop.circle").font(.title3)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(selectedMember?.name ?? String(localized: "Choose a teammate")).font(.body.weight(.medium))
                        if let member = selectedMember { Text(member.role).font(.caption).foregroundStyle(Theme.Colors.textSecondary) }
                    }
                    Spacer()
                    Image(systemName: "chevron.up.chevron.down").font(.caption)
                }.foregroundStyle(Theme.Colors.textPrimary).padding(15)
                    .background(Theme.Colors.surface, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.Colors.border, lineWidth: 1))
            }
            .disabled(appState.workspaceMembers.isEmpty)
            if appState.membersLoading { ProgressView("Loading teammates…").font(.caption) }
            else if appState.workspaceMembers.isEmpty {
                Text(appState.membersError ?? String(localized: "Connect to load your workspace members.")).font(.footnote).foregroundStyle(Theme.Colors.textSecondary)
                Button("Try again") { Task { await appState.refreshWorkspaceMembers() } }.font(.subheadline)
            }
            if model.isReviewing && !appState.isGuest && appState.connectionState != .connected {
                Text("Reconnect to send. Your draft stays editable.").font(.footnote).foregroundStyle(Theme.Colors.reject)
            }
        }
    }
    private var selectedMember: WorkspaceMember? { appState.workspaceMembers.first { $0.id == model.recipientID } }
    private func fieldLabel(_ title: LocalizedStringKey) -> some View { Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.Colors.textSecondary) }
    private func priorityLabel(_ priority: CardPriority) -> String {
        switch priority {
        case .low: String(localized: "Low")
        case .medium: String(localized: "Medium")
        case .high: String(localized: "High")
        case .urgent: String(localized: "Urgent")
        }
    }
}
