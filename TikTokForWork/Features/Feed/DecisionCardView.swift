import SwiftUI

struct DecisionCardView: View {
    let card: DecisionCard
    let onAction: (CardActionKind) -> Void

    var body: some View {
        ZStack {
            Theme.Colors.surface.ignoresSafeArea()

            VStack(alignment: .leading, spacing: 0) {
                metadata
                    .padding(.bottom, Theme.Spacing.sm)

                if let route = card.agentRoute {
                    Text(route)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(Theme.Colors.accent.opacity(0.9))
                        .padding(.bottom, Theme.Spacing.xl)
                } else {
                    Spacer().frame(height: Theme.Spacing.xl)
                }

                Text(card.title)
                    .font(.system(size: 22, weight: .medium))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.bottom, Theme.Spacing.md)

                Text(card.summary)
                    .font(.system(size: 15))
                    .foregroundStyle(Theme.Colors.textPrimary.opacity(0.9))
                    .lineSpacing(4)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.bottom, Theme.Spacing.lg)

                Text(card.context)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .lineSpacing(4)
                    .fixedSize(horizontal: false, vertical: true)

                if let issueURL = card.githubIssueURL, let url = URL(string: issueURL) {
                    Link(destination: url) {
                        HStack(spacing: Theme.Spacing.xs) {
                            Text(issueLabel)
                                .font(.system(size: 12, design: .monospaced))
                            Image(systemName: "arrow.up.right")
                                .font(.system(size: 10))
                        }
                        .foregroundStyle(Theme.Colors.accent)
                    }
                    .padding(.top, Theme.Spacing.lg)
                }

                Spacer(minLength: Theme.Spacing.xl)

                if !card.isPending {
                    Text(card.status.label)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.Colors.textTertiary)
                        .padding(.bottom, Theme.Spacing.md)
                }

                actions
            }
            .padding(.horizontal, Theme.Spacing.screen)
            .padding(.top, 72)
            .padding(.bottom, 96)
        }
    }

    private var issueLabel: String {
        if let number = card.githubIssueNumber {
            return "Issue #\(number)"
        }
        return "GitHub"
    }

    private var metadata: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Text(card.type.label.uppercased())
            Text("·")
            Text(card.priority.rawValue)
            Text("·")
            Text(card.senderName)
            Text("·")
            Text(DateFormatting.relative(card.createdAt))
        }
        .font(.system(size: 11))
        .foregroundStyle(Theme.Colors.textTertiary)
        .lineLimit(1)
        .minimumScaleFactor(0.85)
    }

    private var actions: some View {
        VStack(spacing: Theme.Spacing.sm) {
            Button {
                Haptics.light()
                onAction(.approve)
            } label: {
                Text("Approve")
                    .font(.system(size: 15, weight: .medium))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(Theme.Colors.accent)
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
            .disabled(!card.isPending)
            .opacity(card.isPending ? 1 : 0.35)

            HStack(spacing: Theme.Spacing.lg) {
                textAction("Reject", color: Theme.Colors.reject) { onAction(.reject) }
                textAction("Revise") { onAction(.requestRevision) }
                textAction("Delegate") { onAction(.delegate) }
            }
            .frame(maxWidth: .infinity)
            .opacity(card.isPending ? 1 : 0.35)
            .disabled(!card.isPending)
        }
    }

    private func textAction(_ title: String, color: Color = Theme.Colors.textSecondary, action: @escaping () -> Void) -> some View {
        Button {
            Haptics.light()
            action()
        } label: {
            Text(title)
                .font(.system(size: 14))
                .foregroundStyle(color)
        }
    }
}

#Preview {
    DecisionCardView(
        card: DecisionCard(
            id: "preview",
            recipientUserID: "user-bob",
            senderUserID: "user-alice",
            type: .approval,
            title: "Approve onboarding PR",
            summary: "Review onboarding redesign before merge window closes.",
            context: "PR #42 · QA passed on staging",
            status: .pending,
            priority: .high,
            createdAt: .now,
            githubIssueNumber: nil,
            githubIssueURL: nil,
            agentRoute: "Alice's AI → Bob's AI"
        ),
        onAction: { _ in }
    )
}
