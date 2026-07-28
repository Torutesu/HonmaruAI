import SwiftUI

struct DecisionCardView: View {
    let card: DecisionCard
    let onAction: (CardActionKind) -> Void

    var body: some View {
        ZStack {
            Theme.Colors.background.ignoresSafeArea()

            VStack(alignment: .leading, spacing: 0) {
                header
                    .padding(.bottom, Theme.Spacing.xl)

                Text(card.title)
                    .font(Theme.TypeScale.title)
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.bottom, Theme.Spacing.md)

                Text(card.summary)
                    .font(Theme.TypeScale.body)
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .lineSpacing(5)
                    .fixedSize(horizontal: false, vertical: true)

                if !card.context.isEmpty {
                    Text(card.context)
                        .font(Theme.TypeScale.caption)
                        .foregroundStyle(Theme.Colors.textTertiary)
                        .lineSpacing(4)
                        .padding(.top, Theme.Spacing.lg)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let issueURL = card.githubIssueURL, let url = URL(string: issueURL) {
                    Link(destination: url) {
                        HStack(spacing: 4) {
                            Text(issueLabel)
                            Image(systemName: "arrow.up.right")
                                .font(.system(size: 10))
                        }
                        .font(Theme.TypeScale.label)
                        .foregroundStyle(Theme.Colors.accent)
                    }
                    .padding(.top, Theme.Spacing.md)
                }

                Spacer(minLength: Theme.Spacing.lg)

                if !card.isPending {
                    Text(card.status.label)
                        .font(Theme.TypeScale.label)
                        .foregroundStyle(Theme.Colors.textTertiary)
                        .padding(.bottom, Theme.Spacing.sm)
                }

                actionBlock
            }
            .padding(.horizontal, Theme.Spacing.screen)
            .padding(.top, 64)
            .padding(.bottom, 88)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(spacing: Theme.Spacing.sm) {
                Text(card.type.label)
                    .font(Theme.TypeScale.label)
                    .foregroundStyle(Theme.Colors.textSecondary)

                if card.priority == .urgent || card.priority == .high {
                    Text(priorityLabel)
                        .font(Theme.TypeScale.micro)
                        .foregroundStyle(priorityColor)
                }

                Spacer()

                Text(DateFormatting.relative(card.createdAt))
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(Theme.Colors.textTertiary)
            }

            Text("From \(card.senderName)")
                .font(Theme.TypeScale.micro)
                .foregroundStyle(Theme.Colors.textTertiary)

            if let route = card.agentRoute {
                Text(route)
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(Theme.Colors.textTertiary.opacity(0.8))
            }
        }
    }

    private var priorityLabel: String {
        switch card.priority {
        case .urgent: "Urgent"
        case .high: "High"
        case .medium: "Medium"
        case .low: "Low"
        }
    }

    private var priorityColor: Color {
        switch card.priority {
        case .urgent: Theme.Colors.reject
        case .high: Color(hex: 0xFBBF24)
        default: Theme.Colors.textTertiary
        }
    }

    private var issueLabel: String {
        if let number = card.githubIssueNumber {
            return "Issue #\(number)"
        }
        return "View on GitHub"
    }

    private var actionBlock: some View {
        VStack(spacing: Theme.Spacing.sm) {
            PrimaryButton(title: "Approve", enabled: card.isPending) {
                Haptics.light()
                onAction(.approve)
            }

            HStack(spacing: 0) {
                SecondaryAction(title: "Reject", tint: Theme.Colors.reject) {
                    Haptics.light()
                    onAction(.reject)
                }
                .disabled(!card.isPending)
                .opacity(card.isPending ? 1 : 0.35)

                SecondaryAction(title: "Revise") {
                    Haptics.light()
                    onAction(.requestRevision)
                }
                .disabled(!card.isPending)
                .opacity(card.isPending ? 1 : 0.35)

                SecondaryAction(title: "Delegate") {
                    Haptics.light()
                    onAction(.delegate)
                }
                .disabled(!card.isPending)
                .opacity(card.isPending ? 1 : 0.35)
            }
        }
    }
}

#Preview {
    DecisionCardView(
        card: DecisionCard(
            id: "preview",
            recipientUserID: "user-alice",
            senderUserID: "user-bob",
            type: .task,
            title: "Auth latency regression",
            summary: "p95 on auth endpoint up 18% after last deploy.",
            context: "Hotfix branch recommended before Friday demo",
            status: .pending,
            priority: .urgent,
            createdAt: .now.addingTimeInterval(-3600),
            githubIssueNumber: nil,
            githubIssueURL: nil,
            agentRoute: "Bob's AI → Alice's AI"
        ),
        onAction: { _ in }
    )
}
