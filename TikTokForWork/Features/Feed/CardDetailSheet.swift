import SwiftUI

struct CardDetailSheet: View {
    let card: DecisionCard
    /// Whether this is still yours to work on. A decided card is a record.
    var canEdit: Bool = false
    var isRefining: Bool = false
    var onChangePriority: ((CardPriority) -> Void)?
    var onAskAI: ((String) async -> Void)?

    @Environment(\.dismiss) private var dismiss
    @State private var instruction = ""
    @FocusState private var instructionFocused: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    if canEdit {
                        // The two things the brief lists that the card front
                        // has no room for: how urgent this is, and asking your
                        // own AI to make it easier to answer.
                        priorityControl
                        askYourAI
                    }

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
                            metaRow(String(localized: "Type"), card.type.label)
                            if !canEdit {
                                metaRow(String(localized: "Priority"), label(for: card.priority))
                            }
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

    /// How urgent this is, decided by the person who has to act on it. The
    /// sender set it once, at draft time, from the other side of the problem.
    private var priorityControl: some View {
        detailSection(title: String(localized: "Priority")) {
            HStack(spacing: Theme.Spacing.xs) {
                ForEach(CardPriority.allCases, id: \.self) { level in
                    Button {
                        onChangePriority?(level)
                    } label: {
                        Text(label(for: level))
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(level == card.priority ? .white : Theme.Colors.textSecondary)
                            .padding(.horizontal, Theme.Spacing.md)
                            .padding(.vertical, 7)
                            .background(level == card.priority ? Theme.Colors.ctaFill : Theme.Colors.surfaceRaised)
                            .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(level == card.priority ? [.isSelected] : [])
                }
            }
        }
    }

    /// Your AI, your card. It reworks what you are looking at and sends nothing
    /// to anyone — the way to answer a card you cannot answer yet.
    private var askYourAI: some View {
        detailSection(title: String(localized: "Ask your AI")) {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                TextField(
                    String(localized: "Just give me the numbers"),
                    text: $instruction,
                    axis: .vertical
                )
                .lineLimit(1...3)
                .font(Theme.TypeScale.caption)
                .focused($instructionFocused)
                .padding(.horizontal, Theme.Spacing.md)
                .padding(.vertical, 10)
                .overlay {
                    RoundedRectangle(cornerRadius: Theme.Radius.input)
                        .strokeBorder(Theme.Colors.border, lineWidth: 1)
                }
                .disabled(isRefining)

                HStack(spacing: Theme.Spacing.sm) {
                    if isRefining {
                        ProgressView().controlSize(.small)
                        Text("Rewriting this for you…")
                            .font(Theme.TypeScale.micro)
                            .foregroundStyle(Theme.Colors.textTertiary)
                    } else {
                        Button("Rewrite this card") {
                            let asked = instruction
                            instruction = ""
                            instructionFocused = false
                            Task { await onAskAI?(asked) }
                        }
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Theme.Colors.interactive)
                        .disabled(instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
        }
    }

    private func label(for priority: CardPriority) -> String {
        switch priority {
        case .low: String(localized: "Low")
        case .medium: String(localized: "Medium")
        case .high: String(localized: "High")
        case .urgent: String(localized: "Urgent")
        }
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
