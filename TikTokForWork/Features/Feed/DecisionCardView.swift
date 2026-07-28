import SwiftUI

struct DecisionCardView: View {
    let card: DecisionCard
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
                    .padding(.bottom, Theme.Spacing.xl)

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
                            Text(card.context)
                                .font(Theme.TypeScale.caption)
                                .foregroundStyle(Theme.Colors.textTertiary)
                                .lineSpacing(4)
                                .multilineTextAlignment(.leading)
                        }

                        Text("View details")
                            .font(Theme.TypeScale.label)
                            .foregroundStyle(Theme.Colors.accent)
                            .padding(.top, Theme.Spacing.xs)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain)

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
            .offset(x: dragOffset)
            .gesture(swipeGesture)
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

            if let reason = card.routingReason {
                Text(reason)
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(Theme.Colors.accent.opacity(0.9))
                    .padding(.horizontal, Theme.Spacing.sm)
                    .padding(.vertical, Theme.Spacing.xs)
                    .background(Theme.Colors.surfaceRaised)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                    .padding(.top, Theme.Spacing.xs)
            }
        }
    }

    private var swipeHintLayer: some View {
        ZStack {
            if dragOffset > 24 {
                HStack {
                    swipeLabel("Approve", color: Theme.Colors.approve)
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
        DragGesture(minimumDistance: 16, coordinateSpace: .local)
            .onChanged { value in
                guard card.isPending else { return }
                dragOffset = value.translation.width
            }
            .onEnded { value in
                guard card.isPending else {
                    resetDrag()
                    return
                }

                if value.translation.width > swipeThreshold {
                    Haptics.success()
                    onAction(.approve)
                } else if value.translation.width < -swipeThreshold {
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

            if card.isPending {
                Text("Swipe right to approve · left to reject")
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(Theme.Colors.textTertiary)
                    .frame(maxWidth: .infinity)
                    .padding(.top, Theme.Spacing.xs)
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
            agentRoute: "Bob's AI → Alice's AI",
            routingReason: "You are Bob's manager"
        ),
        onAction: { _ in },
        onShowDetails: {}
    )
}
