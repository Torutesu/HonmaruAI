import SwiftUI

/// Standalone draft/send pipeline so the Assistant tab can route instructions
/// without borrowing the feed's view model.
@MainActor
final class InstructionComposer: ObservableObject {
    @Published var isDrafting = false
    @Published var reviewDraft: InstructionDraft?
    @Published var errorMessage: String?

    private var draftTask: Task<Void, Never>?

    func beginDraft(_ text: String, priority: CardPriority, appState: AppState) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let user = appState.currentUser else { return }
        guard appState.aiService.hasRelay else {
            errorMessage = AIServiceError.notConfigured.localizedDescription
            return
        }

        draftTask?.cancel()
        errorMessage = nil
        isDrafting = true

        draftTask = Task {
            do {
                let draft = try await appState.aiService.draftInstruction(
                    text: trimmed,
                    sender: user,
                    organization: DemoData.organization,
                    priorityOverride: priority
                )
                guard !Task.isCancelled else { return }
                reviewDraft = draft
            } catch {
                errorMessage = error.localizedDescription
            }
            isDrafting = false
        }
    }

    func send(_ draft: InstructionDraft, appState: AppState) async {
        guard let user = appState.currentUser else { return }
        do {
            _ = try await appState.cardService.processRouting(
                draft.asRouting(),
                sourceText: draft.sourceText,
                from: user
            )
            Haptics.success()
        } catch {
            errorMessage = error.localizedDescription
        }
        reviewDraft = nil
    }
}

struct AssistantView: View {
    @EnvironmentObject private var appState: AppState
    @StateObject private var composer = InstructionComposer()
    @State private var prompt = ""
    @State private var showInput = false
    @State private var sentCards: [DecisionCard] = []

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                    hero

                    ComposeBar(placeholder: "Tell your AI") {
                        showInput = true
                    }

                    if composer.isDrafting {
                        HStack(spacing: Theme.Spacing.sm) {
                            ProgressView()
                                .controlSize(.small)
                                .tint(Theme.Colors.textSecondary)
                            Text("Drafting decision card…")
                                .font(Theme.TypeScale.caption)
                                .foregroundStyle(Theme.Colors.textSecondary)
                        }
                    }

                    if let error = composer.errorMessage {
                        Text(error)
                            .font(Theme.TypeScale.label)
                            .foregroundStyle(Theme.Colors.reject)
                    }

                    VStack(spacing: Theme.Spacing.sm) {
                        NavigationLink {
                            AssistantContextView()
                        } label: {
                            navRow(icon: "brain", title: "What your AI knows", detail: "Org position, tools, repository")
                        }

                        NavigationLink {
                            AgentActivityView()
                        } label: {
                            navRow(icon: "arrow.triangle.branch", title: "Agent activity", detail: "Routing and delivery log")
                        }
                    }

                    recentInstructions
                }
                .padding(Theme.Spacing.screen)
            }
            .background(Theme.Colors.background)
            .navigationTitle("Assistant")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.Colors.background, for: .navigationBar)
        }
        .onAppear(perform: refresh)
        .sheet(isPresented: $showInput) {
            AIInputSheet(
                prompt: $prompt,
                isAIConfigured: appState.aiService.isConfigured,
                onSubmit: { text, priority in
                    composer.beginDraft(text, priority: priority, appState: appState)
                }
            )
            .presentationDetents([.medium, .large])
            .presentationBackground(Theme.Colors.surface)
            .presentationDragIndicator(.visible)
        }
        .sheet(item: $composer.reviewDraft) { draft in
            DraftReviewSheet(draft: draft) { finalDraft in
                Task {
                    await composer.send(finalDraft, appState: appState)
                    prompt = ""
                    refresh()
                }
            }
            .presentationDetents([.medium, .large])
            .presentationBackground(Theme.Colors.surface)
            .presentationDragIndicator(.visible)
        }
    }

    private var agentName: String {
        DemoData.agentName(for: appState.currentUser?.id ?? "")
    }

    private var hero: some View {
        HStack(spacing: Theme.Spacing.md) {
            Image(systemName: "sparkle")
                .font(.system(size: 20))
                .foregroundStyle(Theme.Colors.accent)
                .frame(width: 48, height: 48)
                .background(Theme.Colors.surfaceRaised)
                .clipShape(Circle())

            VStack(alignment: .leading, spacing: 2) {
                Text(agentName)
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(Theme.Colors.textPrimary)
                HStack(spacing: 6) {
                    Circle()
                        .fill(appState.aiService.isConfigured ? Theme.Colors.approve : Theme.Colors.textTertiary)
                        .frame(width: 5, height: 5)
                    Text(appState.aiService.isConfigured ? "Online · routing through relay" : "Offline · local keyword routing")
                        .font(Theme.TypeScale.label)
                        .foregroundStyle(Theme.Colors.textTertiary)
                }
            }

            Spacer()
        }
    }

    private func navRow(icon: String, title: String, detail: String) -> some View {
        HStack(spacing: Theme.Spacing.md) {
            Image(systemName: icon)
                .font(.system(size: 14))
                .foregroundStyle(Theme.Colors.textSecondary)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Theme.Colors.textPrimary)
                Text(detail)
                    .font(Theme.TypeScale.label)
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Theme.Colors.textTertiary)
        }
        .padding(Theme.Spacing.md)
        .background(Theme.Colors.surface)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
    }

    private var recentInstructions: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("Recent instructions")
                .font(Theme.TypeScale.micro)
                .foregroundStyle(Theme.Colors.textTertiary)
                .textCase(.uppercase)
                .tracking(0.8)

            if sentCards.isEmpty {
                Text("Nothing routed yet — your AI is waiting for its first instruction.")
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textTertiary)
                    .padding(.vertical, Theme.Spacing.sm)
            } else {
                ForEach(sentCards.prefix(5)) { card in
                    VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                        Text(card.sourceInstruction ?? card.title)
                            .font(Theme.TypeScale.body)
                            .foregroundStyle(Theme.Colors.textPrimary)
                            .lineLimit(2)
                        Text("→ \(DemoData.userName(for: card.recipientUserID)) · \(DateFormatting.relative(card.createdAt))")
                            .font(Theme.TypeScale.label)
                            .foregroundStyle(Theme.Colors.textTertiary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Theme.Spacing.md)
                    .background(Theme.Colors.surface)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
                }
            }
        }
    }

    private func refresh() {
        guard let userID = appState.currentUser?.id else { return }
        sentCards = appState.cardService.cards(sentBy: userID).filter { $0.type != .notification }
    }
}

#Preview {
    let state = AppState()
    AssistantView()
        .environmentObject(state)
        .environmentObject(state.preferences)
}
