import SwiftUI

struct DecisionCardView: View {
    let card: DecisionCard
    let linkedRepository: String
    let onAction: (CardActionKind) -> Void
    let onShowDetails: () -> Void

    @State private var dragOffset: CGFloat = 0

    private let swipeThreshold: CGFloat = 96

    var body: some View {
        ZStack {
            Theme.Colors.background.ignoresSafeArea()

            swipeHintLayer

            VStack(alignment: .leading, spacing: 0) {
                header
                    .padding(.bottom, Theme.Spacing.lg)

                Button(action: onShowDetails) {
                    VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                        Text(card.title)
                            .font(Theme.TypeScale.title)
                            .foregroundStyle(Theme.Colors.textPrimary)
                            .lineSpacing(2)
                            .multilineTextAlignment(.leading)

                        Text(card.summary)
                            .font(Theme.TypeScale.body)
                            .foregroundStyle(Theme.Colors.textSecondary)
                            .lineSpacing(5)
                            .multilineTextAlignment(.leading)

                        if !card.context.isEmpty {
                            ContextInsightView(context: card.context, compact: true)
                        }

                        Text("View details")
                            .font(Theme.TypeScale.label)
                            .foregroundStyle(Theme.Colors.accent)
                            .padding(.top, Theme.Spacing.xs)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain)

                if card.showsGitHubLink(for: linkedRepository),
                   let issueURL = card.githubIssueURL,
                   let url = URL(string: issueURL) {
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
            .padding(.top, Theme.Spacing.md)
            .padding(.bottom, Theme.Spacing.md)
            .offset(x: dragOffset)
        }
        .contentShape(Rectangle())
        .simultaneousGesture(swipeGesture)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.sm) {
                Text(card.type.label)
                    .font(Theme.TypeScale.label)
                    .foregroundStyle(Theme.Colors.textSecondary)

                if card.priority == .urgent || card.priority == .high {
                    Text("·")
                        .font(Theme.TypeScale.micro)
                        .foregroundStyle(Theme.Colors.textTertiary)
                    Text(priorityLabel)
                        .font(Theme.TypeScale.label)
                        .foregroundStyle(priorityColor)
                } else {
                    Text("·")
                        .font(Theme.TypeScale.micro)
                        .foregroundStyle(Theme.Colors.textTertiary)
                    Text(card.priorityLabel)
                        .font(Theme.TypeScale.label)
                        .foregroundStyle(Theme.Colors.textTertiary)
                }

                Spacer(minLength: Theme.Spacing.sm)

                Text(DateFormatting.relative(card.createdAt))
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(Theme.Colors.textTertiary)
            }

            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                Text("From \(card.senderName)")
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textSecondary)

                if let route = card.agentRoute {
                    Text(route)
                        .font(Theme.TypeScale.micro)
                        .foregroundStyle(Theme.Colors.textTertiary)
                }
            }

            if let reason = card.routingReason {
                HStack(spacing: Theme.Spacing.sm) {
                    RoundedRectangle(cornerRadius: 1)
                        .fill(Theme.Colors.accent)
                        .frame(width: 2)

                    Text(reason)
                        .font(Theme.TypeScale.caption)
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, Theme.Spacing.md)
                .padding(.vertical, Theme.Spacing.sm)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.Colors.surfaceRaised)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
        }
    }

    private var swipeHintLayer: some View {
        ZStack {
            if dragOffset > 24 {
                HStack {
                    swipeLabel(rightSwipeTitle, color: Theme.Colors.issueGreen)
                    Spacer()
                }
                .padding(.leading, Theme.Spacing.screen)
            }

            if dragOffset < -24, !card.isNotification {
                HStack {
                    Spacer()
                    swipeLabel("Reject", color: Theme.Colors.reject)
                }
                .padding(.trailing, Theme.Spacing.screen)
            }
        }
        .opacity(min(abs(dragOffset) / swipeThreshold, 1))
        .allowsHitTesting(false)
    }

    private func swipeLabel(_ title: String, color: Color) -> some View {
        Text(title)
            .font(.system(size: 15, weight: .medium))
            .foregroundStyle(color)
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, Theme.Spacing.sm)
            .background(color.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }

    private var swipeGesture: some Gesture {
        DragGesture(minimumDistance: 20, coordinateSpace: .local)
            .onChanged { value in
                guard card.isPending else { return }
                let horizontal = value.translation.width
                let vertical = value.translation.height
                guard abs(horizontal) > abs(vertical) else { return }
                dragOffset = horizontal
            }
            .onEnded { value in
                guard card.isPending else {
                    resetDrag()
                    return
                }

                let horizontal = value.translation.width
                let vertical = value.translation.height
                guard abs(horizontal) > abs(vertical) else {
                    resetDrag()
                    return
                }

                if horizontal > swipeThreshold {
                    Haptics.success()
                    onAction(rightSwipeAction)
                } else if horizontal < -swipeThreshold, !card.isNotification {
                    Haptics.light()
                    onAction(.reject)
                }

                resetDrag()
            }
    }

    private func resetDrag() {
        withAnimation(.easeOut(duration: 0.18)) {
            dragOffset = 0
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

    private var rightSwipeAction: CardActionKind {
        if card.isRevisionRequest { return .reviseResend }
        if card.isNotification { return .acknowledge }
        return .createIssue
    }

    private var rightSwipeTitle: String {
        if card.isRevisionRequest { return "Revise and resend" }
        if card.isNotification { return "Mark as read" }
        return "Create issue"
    }

    private var replyBar: some View {
        Button {
            Haptics.light()
            onAction(.reply)
        } label: {
            HStack(spacing: Theme.Spacing.sm) {
                Image(systemName: "text.bubble")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.Colors.textTertiary)
                Text("Reply — add a condition, ask a question…")
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textTertiary)
                Spacer()
            }
            .padding(Theme.Spacing.md)
            .background(Theme.Colors.surfaceRaised)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
        .buttonStyle(.plain)
    }

    private var actionBlock: some View {
        VStack(spacing: Theme.Spacing.sm) {
            if card.isPending, !card.isNotification, !card.isRevisionRequest,
               let recommendation = card.recommendation,
               let suggested = recommendation.cardAction {
                Button {
                    Haptics.success()
                    onAction(suggested)
                } label: {
                    HStack(alignment: .top, spacing: Theme.Spacing.sm) {
                        Image(systemName: "sparkle")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.Colors.accent)
                            .padding(.top, 2)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Your AI suggests: \(recommendation.label)")
                                .font(.system(size: 13, weight: .medium))
                                .foregroundStyle(Theme.Colors.accent)
                            Text("\(recommendation.reason) · tap to accept")
                                .font(Theme.TypeScale.micro)
                                .foregroundStyle(Theme.Colors.textSecondary)
                                .multilineTextAlignment(.leading)
                        }
                        Spacer()
                    }
                    .padding(Theme.Spacing.md)
                    .background(Theme.Colors.accent.opacity(0.10))
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                }
                .buttonStyle(.plain)
            }

            if card.isPending {
                replyBar
            }

            if card.isPending, card.isRevisionRequest {
                PrimaryButton(title: "Revise and resend") {
                    Haptics.light()
                    onAction(.reviseResend)
                }

                HStack(spacing: 0) {
                    SecondaryAction(title: "Decline", tint: Theme.Colors.reject) {
                        Haptics.light()
                        onAction(.reject)
                    }

                    SecondaryAction(title: "Ask AI") {
                        Haptics.light()
                        onAction(.askAI)
                    }
                }

                Text("Swipe right to resend · left to decline")
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(Theme.Colors.textTertiary)
                    .frame(maxWidth: .infinity)
                    .padding(.top, Theme.Spacing.xs)
            } else if card.isPending, card.isNotification {
                SecondaryAction(title: "Mark as read") {
                    Haptics.light()
                    onAction(.acknowledge)
                }
                .frame(maxWidth: .infinity)

                Text("Swipe right to mark as read · reply above to respond")
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(Theme.Colors.textTertiary)
                    .frame(maxWidth: .infinity)
                    .padding(.top, Theme.Spacing.xs)
            } else if card.isPending {
                GitHubPrimaryButton(title: "Create issue", enabled: true) {
                    Haptics.light()
                    onAction(.createIssue)
                }

                HStack(spacing: 0) {
                    SecondaryAction(title: "Decline", tint: Theme.Colors.reject) {
                        Haptics.light()
                        onAction(.reject)
                    }

                    SecondaryAction(title: "Revise") {
                        Haptics.light()
                        onAction(.requestRevision)
                    }

                    SecondaryAction(title: "Delegate") {
                        Haptics.light()
                        onAction(.delegate)
                    }

                    SecondaryAction(title: "Ask AI") {
                        Haptics.light()
                        onAction(.askAI)
                    }
                }

                Text("Swipe right to create issue · left to decline")
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(Theme.Colors.textTertiary)
                    .frame(maxWidth: .infinity)
                    .padding(.top, Theme.Spacing.xs)
            } else if card.canDelete {
                SecondaryAction(title: "Delete", tint: Theme.Colors.reject) {
                    Haptics.light()
                    onAction(.delete)
                }
                .frame(maxWidth: .infinity)
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
                context: "deadline: Friday demo · action: hotfix branch · metric: p95 +18%",
            status: .pending,
            priority: .urgent,
            createdAt: .now.addingTimeInterval(-3600),
            githubIssueNumber: nil,
            githubIssueURL: nil,
            agentRoute: "Bob's AI → Alice's AI",
            routingReason: "You are Bob's manager"
        ),
        linkedRepository: "owner/repo",
        onAction: { _ in },
        onShowDetails: {}
    )
}
