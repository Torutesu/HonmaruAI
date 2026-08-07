import SwiftUI

struct CardDetailSheet: View {
    let card: DecisionCard
    @ObservedObject var cardService: DecisionCardService
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var replyText = ""

    private static let quickReplies = ["👍 Got it", "On it — today", "Need more info", "Ship it 🚀"]

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

                    detailSection(title: "Thread") {
                        threadSection
                    }
                }
                .padding(Theme.Spacing.screen)
            }
            .background(Theme.Colors.background)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                replyBar
            }
            .onAppear { loadThread() }
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

    private var messages: [CardMessage] {
        cardService.messagesByCard[card.id] ?? []
    }

    private var threadSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            if messages.isEmpty {
                Text("Replies land instantly — no AI in this path.")
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
            ForEach(messages) { message in
                messageBubble(message)
            }
        }
    }

    private func messageBubble(_ message: CardMessage) -> some View {
        let isMine = message.authorUserId == appState.currentUser?.id
        return VStack(
            alignment: isMine ? .trailing : .leading,
            spacing: 2
        ) {
            Text(message.text)
                .font(Theme.TypeScale.body)
                .foregroundStyle(isMine ? Color.white : Theme.Colors.textPrimary)
                .padding(.horizontal, Theme.Spacing.md)
                .padding(.vertical, Theme.Spacing.sm)
                .background(isMine ? Theme.Colors.accent : Theme.Colors.surfaceRaised)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
            Text("\(message.authorName) · \(DateFormatting.relative(message.createdAt))")
                .font(Theme.TypeScale.micro)
                .foregroundStyle(Theme.Colors.textTertiary)
        }
        .frame(maxWidth: .infinity, alignment: isMine ? .trailing : .leading)
    }

    private var replyBar: some View {
        VStack(spacing: Theme.Spacing.sm) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(Self.quickReplies, id: \.self) { reply in
                        Button(reply) { send(reply) }
                            .font(Theme.TypeScale.label)
                            .foregroundStyle(Theme.Colors.textSecondary)
                            .padding(.horizontal, Theme.Spacing.md)
                            .padding(.vertical, 6)
                            .background(Theme.Colors.surfaceRaised)
                            .clipShape(Capsule())
                    }
                }
            }
            HStack(spacing: Theme.Spacing.sm) {
                TextField("Reply…", text: $replyText)
                    .font(Theme.TypeScale.body)
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .padding(Theme.Spacing.md)
                    .background(Theme.Colors.surfaceRaised)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
                    .onSubmit { send(replyText) }
                Button {
                    send(replyText)
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 40, height: 40)
                        .background(Theme.Colors.accent)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
                }
            }
        }
        .padding(.horizontal, Theme.Spacing.screen)
        .padding(.vertical, Theme.Spacing.sm)
        .background(Theme.Colors.surface)
    }

    private func send(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        replyText = ""
        Task {
            try? await cardService.sendMessage(cardID: card.id, text: trimmed)
            Haptics.light()
        }
    }

    private func loadThread() {
        guard let api = appState.api, let token = SessionStore.sessionToken else { return }
        Task {
            if let history = try? await api.listMessages(token: token, cardID: card.id) {
                cardService.seedMessages(cardID: card.id, messages: history)
            }
        }
    }

    private var issueLabel: String {
        if let number = card.githubIssueNumber {
            return "Issue #\(number)"
        }
        return "View on GitHub"
    }

    private func detailSection<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text(title)
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
