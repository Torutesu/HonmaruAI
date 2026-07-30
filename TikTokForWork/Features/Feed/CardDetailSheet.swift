import SwiftUI

struct CardDetailSheet: View {
    let card: DecisionCard
    var onSetPriority: ((CardPriority) -> Void)?
    @State private var priority: CardPriority
    @Environment(\.dismiss) private var dismiss

    init(card: DecisionCard, onSetPriority: ((CardPriority) -> Void)? = nil) {
        self.card = card
        self.onSetPriority = onSetPriority
        _priority = State(initialValue: card.priority)
    }

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

                    if card.isPending, onSetPriority != nil {
                        PrioritySlider(priority: $priority)
                            .onChange(of: priority) { _, newValue in
                                guard newValue != card.priority else { return }
                                onSetPriority?(newValue)
                            }
                    }

                    detailSection(title: "Routing") {
                        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                            metaRow("From", card.senderName)
                            metaRow("Type", card.type.label)
                            metaRow("Priority", priority.rawValue.capitalized)
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
