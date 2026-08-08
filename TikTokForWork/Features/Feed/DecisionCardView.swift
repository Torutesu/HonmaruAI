import SwiftUI

struct DecisionCardView: View {
    let card: DecisionCard
    let linkedRepository: String
    var isGitHubConnected: Bool = true
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

                // A3 in the mock replies to a card in free text. The reply layer
                // that would interpret it lives on another branch, so this is
                // shown inert and labelled rather than wired to nothing.
                if card.isPending {
                    replyComposerPlaceholder
                        .padding(.top, Theme.Spacing.sm)
                }
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
            HStack(alignment: .center, spacing: Theme.Spacing.sm) {
                KindTag(type: card.type)

                Spacer(minLength: Theme.Spacing.sm)

                // Priority reads as a dot plus a mono label, so the colour
                // carries the urgency and the word confirms it.
                if card.priority == .urgent || card.priority == .high {
                    HStack(spacing: 5) {
                        Circle()
                            .fill(priorityColor)
                            .frame(width: 5, height: 5)
                        Text(card.priorityLabel.uppercased())
                            .font(.system(size: 10, weight: .medium, design: .monospaced))
                            .tracking(0.7)
                            .foregroundStyle(priorityColor)
                    }
                }
            }

            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                HStack(spacing: Theme.Spacing.sm) {
                    SenderAvatar(name: card.senderName)

                    Text("\(card.senderName) · \(DateFormatting.relative(card.createdAt))")
                        .font(Theme.TypeScale.caption)
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .lineLimit(1)

                    Spacer(minLength: Theme.Spacing.xs)

                    if let route = card.agentRoute {
                        Text(route)
                            .font(.system(size: 10))
                            .foregroundStyle(Theme.Colors.textTertiary)
                            .lineLimit(1)
                    }
                }
            }

            if let reason = card.routingReason {
                // The AI marker is one of the few sanctioned uses of brand
                // violet: a badge, never a fill on a primary action.
                HStack(alignment: .top, spacing: 7) {
                    Image(systemName: "sparkle")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Theme.Colors.accent)

                    Text(reason)
                        .font(Theme.TypeScale.caption)
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, Theme.Spacing.md)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.Colors.accent.opacity(0.07))
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.card))
            }
        }
    }

    private var swipeHintLayer: some View {
        ZStack {
            if dragOffset > 24 {
                HStack {
                    swipeLabel(
                        isGitHubConnected ? "Create issue" : "Approve",
                        color: isGitHubConnected ? Theme.Colors.issueGreen : Theme.Colors.approve
                    )
                    Spacer()
                }
                .padding(.leading, Theme.Spacing.screen)
            }

            if dragOffset < -24 {
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
                    onAction(.createIssue)
                } else if horizontal < -swipeThreshold {
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

    private var replyComposerPlaceholder: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Text("返信または音声入力…")
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textTertiary)
            Spacer()
            Text("準備中")
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(Theme.Colors.textTertiary)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(Theme.Colors.surfaceRaised)
                .clipShape(Capsule())
        }
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.vertical, 10)
        .overlay {
            RoundedRectangle(cornerRadius: Theme.Radius.input)
                .strokeBorder(Theme.Colors.border, lineWidth: 1)
        }
        .allowsHitTesting(false)
    }

    private var priorityLabel: String {
        switch card.priority {
        case .urgent: "Urgent"
        case .high: "High"
        case .medium: "Medium"
        case .low: "Low"
        }
    }

    /// The priority stripe from docs/design-system.md: urgent pink, high blue,
    /// everything quieter than that a neutral cloud.
    private var priorityColor: Color {
        switch card.priority {
        case .urgent: Theme.Colors.reject
        case .high: Theme.Colors.interactive
        default: Color(hex: 0xD4D4D4)
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
            if card.isPending {
                if isGitHubConnected {
                    GitHubPrimaryButton(title: "Create issue", enabled: true) {
                        Haptics.light()
                        onAction(.createIssue)
                    }
                } else {
                    Button {
                        Haptics.light()
                        onAction(.createIssue)
                    } label: {
                        // Filled dark pill. docs/design-system.md lists "violet
                        // never fills a primary CTA" under Don'ts (enforced),
                        // and every button in the system is a pill.
                        Text("Approve")
                            .font(.system(size: 16, weight: .semibold))
                            .frame(maxWidth: .infinity)
                            .frame(height: 48)
                            .background(Theme.Colors.ctaFill)
                            .foregroundStyle(Color.white)
                            .clipShape(Capsule())
                    }
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
                }

                Text(isGitHubConnected
                     ? "Swipe right to create issue · left to decline"
                     : "Swipe right to approve · left to decline")
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
