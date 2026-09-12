import SwiftUI

struct CardDetailSheet: View {
    let card: DecisionCard
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var appState: AppState

    /// "Ask anything" about this card. The question typed, the one being
    /// answered, and what came back. It lives in the sheet, which scrolls,
    /// so the page under it stays one page.
    @State private var question = ""
    @State private var asked: String?
    @State private var answer: AskService.Answer?
    @State private var askError: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    if let reason = card.routingReason {
                        detailSection(title: "Why you") {
                            Text(reason)
                                .font(Theme.TypeScale.body)
                                .foregroundStyle(Theme.Colors.textPrimary)
                        }
                    }

                    detailSection(title: "Summary") {
                        Text(card.summary)
                            .font(Theme.TypeScale.body)
                            .foregroundStyle(Theme.Colors.textSecondary)
                            .lineSpacing(4)
                    }

                    detailSection(title: "Ask your AI") {
                        askBlock
                    }

                    if !card.context.isEmpty {
                        detailSection(title: "Context") {
                            ContextInsightView(context: card.context)
                        }
                    }

                    if let source = card.sourceInstruction, source != card.summary {
                        detailSection(title: "Original message") {
                            Text(source)
                                .font(Theme.TypeScale.caption)
                                .foregroundStyle(Theme.Colors.textTertiary)
                                .lineSpacing(4)
                        }
                    }

                    if let note = card.revisionNote, !note.isEmpty {
                        detailSection(title: "Revision note") {
                            Text(note)
                                .font(Theme.TypeScale.caption)
                                .foregroundStyle(Theme.Colors.textSecondary)
                        }
                    }

                    if let labels = card.labels, !labels.isEmpty {
                        detailSection(title: "Labels") {
                            HStack {
                                ForEach(labels, id: \.self) { label in
                                    LabelChip(text: label)
                                }
                            }
                        }
                    }

                    detailSection(title: "Routing") {
                        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                            metaRow("From", card.senderName)
                            metaRow("Type", card.type.label)
                            metaRow("Priority", card.priority.rawValue.capitalized)
                            metaRow("Status", card.status.label)
                            metaRow("Created", DateFormatting.relative(card.createdAt))
                            if let route = card.agentRoute {
                                metaRow("Agent path", route)
                            }
                        }
                    }

                    if let issueURL = card.githubIssueURL, let url = URL(string: issueURL) {
                        detailSection(title: "GitHub") {
                            Link(destination: url) {
                                HStack(spacing: 6) {
                                    Text(issueLabel)
                                    Image(systemName: "arrow.up.right")
                                        .font(.system(size: 11))
                                }
                                .font(Theme.TypeScale.caption)
                                .foregroundStyle(Theme.Colors.accent)
                            }
                        }
                    }
                }
                .padding(Theme.Spacing.screen)
            }
            .background(Theme.Colors.background)
            .navigationTitle(card.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
        }
        .presentationBackground(Theme.Colors.surface)
        .presentationDragIndicator(.visible)
    }

    private var issueLabel: String {
        if let number = card.githubIssueNumber {
            return "Issue #\(number)"
        }
        return "View on GitHub"
    }

    /// A question about this card, answered from the card and what the team
    /// decided before — the same route the web asks, so both give one answer.
    private var askBlock: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(spacing: Theme.Spacing.sm) {
                TextField(String(localized: "Ask anything…"), text: $question)
                    .font(Theme.TypeScale.body)
                    .submitLabel(.send)
                    .onSubmit(send)
                    .disabled(busy)
                    .accessibilityLabel(String(localized: "Ask your AI about this decision"))
                Button(action: send) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 22))
                        .foregroundStyle(canSend ? Theme.Colors.interactive : Theme.Colors.textTertiary)
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
                .accessibilityLabel(String(localized: "Send"))
            }
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, 10)
            .overlay {
                RoundedRectangle(cornerRadius: Theme.Radius.input)
                    .strokeBorder(Theme.Colors.border, lineWidth: 1)
            }

            if let asked {
                Text(asked)
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
            if busy {
                Text("Your AI is looking…")
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
            if let askError {
                Text(askError)
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.reject)
            }
            if let answer {
                Text(answer.answer)
                    .font(Theme.TypeScale.body)
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .lineSpacing(4)
                    .textSelection(.enabled)
                if !answer.related.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Decided before")
                            .font(Theme.TypeScale.label)
                            .foregroundStyle(Theme.Colors.textTertiary)
                        ForEach(answer.related) { related in
                            HStack(alignment: .top, spacing: Theme.Spacing.sm) {
                                Text(related.when)
                                    .font(Theme.TypeScale.micro)
                                    .foregroundStyle(Theme.Colors.textTertiary)
                                    .frame(width: 72, alignment: .leading)
                                Text(related.title)
                                    .font(Theme.TypeScale.caption)
                                    .foregroundStyle(Theme.Colors.textSecondary)
                            }
                        }
                    }
                    .padding(.top, Theme.Spacing.xs)
                }
            }
        }
        .animation(.easeOut(duration: 0.15), value: busy)
    }

    private var canSend: Bool {
        !busy && !question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func send() {
        let text = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend, !text.isEmpty else { return }
        Haptics.light()
        question = ""
        asked = text
        answer = nil
        askError = nil
        let orgId = appState.currentUser?.teamID ?? SessionStore.orgId ?? ""
        guard let base = appState.backendBaseURL, !orgId.isEmpty else {
            askError = AskService.Failure.notSignedIn.errorDescription
            return
        }
        busy = true
        let language = appState.readerLanguageCode
        Task { @MainActor in
            do {
                answer = try await AskService.ask(
                    cardId: card.id, orgId: orgId, question: text, readerLanguage: language, backendBaseURL: base
                )
            } catch {
                askError = error.localizedDescription
            }
            busy = false
        }
    }

    private func detailSection<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            // The titles are in the catalog; a String is shown verbatim
            // unless it is read as a key.
            Text(LocalizedStringKey(title))
                .font(Theme.TypeScale.label)
                .foregroundStyle(Theme.Colors.textTertiary)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func metaRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top, spacing: Theme.Spacing.md) {
            Text(label)
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textTertiary)
                .frame(width: 72, alignment: .leading)
            Text(value)
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
