import SwiftUI

struct DecisionCardView: View {
    let card: DecisionCard
    let linkedRepository: String
    var isGitHubConnected: Bool = true
    let onAction: (CardActionKind) -> Void
    let onShowDetails: () -> Void

    @EnvironmentObject private var appState: AppState
    @State private var dragOffset: CGFloat = 0
    @State private var showsSource = false

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
                            // A long title at a large text size otherwise
                            // pushes everything below it off the page.
                            .minimumScaleFactor(0.8)

                        Text(card.summary)
                            .font(Theme.TypeScale.body)
                            .foregroundStyle(Theme.Colors.textSecondary)
                            .lineSpacing(5)
                            .multilineTextAlignment(.leading)
                            .minimumScaleFactor(0.85)

                        if let original = card.originalBody,
                           let language = card.originalLanguage {
                            TranslatedFrom(language: language, original: original)
                        }

                        // Blocks the agent's own facts justify, then the rest of
                        // the context as prose.
                        GeneratedBlocks(card: card)

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

                if let videoURL = card.videoURL {
                    CardVideoView(urlString: videoURL)
                        .frame(height: 220)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.image))
                }

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

                // A3 replies to a card in free text. It opens the revision flow,
                // which is what a reply means here: the card goes back to the
                // sender with what you said attached.
                if card.isPending {
                    replyComposer
                        .padding(.top, Theme.Spacing.sm)
                }
            }
            .padding(.horizontal, Theme.Spacing.screen)
            .padding(.top, Theme.Spacing.md)
            .padding(.bottom, Theme.Spacing.md)
            .offset(x: dragOffset)
        }
        .contentShape(Rectangle())
        // One card fills one page and cannot scroll — that is the whole feed
        // gesture. At the accessibility text sizes the content grew past the
        // page and took the action row with it, off-screen, with no way to
        // reach it. Nesting a scroll view inside a paging one to fix that
        // fights the gesture the product is built on, so the text is allowed to
        // grow to the largest size the layout survives and stops there.
        //
        // This is a compromise, and it is only tolerable because the actions do
        // not depend on it: the rotor actions below reach approve, decline,
        // revise and delegate at any size, including the ones clamped here.
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
        .simultaneousGesture(swipeGesture)
        // VoiceOver owns horizontal swipes, so the card's primary gesture does
        // not exist for anyone using it. The action row below is reachable, but
        // only after paging through the whole card — these put approve and
        // decline on the rotor, where the swipe would have been.
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(accessibilitySummary))
        .accessibilityActions {
            if card.isPending {
                Button(String(localized: "Approve")) {
                    Haptics.success()
                    onAction(.createIssue)
                }
                Button(String(localized: "Decline")) {
                    Haptics.light()
                    onAction(.reject)
                }
                Button(String(localized: "Request revision")) { onAction(.requestRevision) }
                Button(String(localized: "Delegate")) { onAction(.delegate) }
            }
            Button(String(localized: "View details")) { onShowDetails() }
        }
        .sheet(isPresented: $showsSource) {
            if let app = card.sourceApp {
                SourceSheet(app: app, detail: card.sourceDetail, card: card)
                    .presentationDetents([.medium, .large])
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            HStack(alignment: .center, spacing: Theme.Spacing.sm) {
                KindTag(type: card.type)

                // How long this has sat. A card looks identical on day six and
                // day one, which is how decisions rot without anyone deciding
                // to let them.
                if let days = card.waitingDays {
                    HStack(spacing: 5) {
                        Image(systemName: "clock")
                            .font(.system(size: 9, weight: .medium))
                        Text("Waiting \(days)d")
                            .font(.system(size: 10, weight: .medium, design: .monospaced))
                            .tracking(0.5)
                    }
                    .foregroundStyle(card.isStale ? Theme.Colors.reject : Theme.Colors.textTertiary)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background((card.isStale ? Theme.Colors.reject : Theme.Colors.textTertiary).opacity(0.10))
                    .clipShape(Capsule())
                    .accessibilityLabel(Text("Waiting \(days) days"))
                }

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

                    if let app = card.sourceApp {
                        Button { showsSource = true } label: {
                            SourceChip(app: app, detail: card.sourceDetail)
                        }
                        .buttonStyle(.plain)
                    } else if let route = card.agentRoute {
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
                        isGitHubConnected ? String(localized: "Create issue") : String(localized: "Approve"),
                        color: isGitHubConnected ? Theme.Colors.issueGreen : Theme.Colors.approve
                    )
                    Spacer()
                }
                .padding(.leading, Theme.Spacing.screen)
            }

            if dragOffset < -24 {
                HStack {
                    Spacer()
                    swipeLabel(String(localized: "Reject"), color: Theme.Colors.reject)
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

    /// What the card is, said once, in the order a person would ask: what has to
    /// be decided, how urgent, who it came from, and whether it is still open.
    private var accessibilitySummary: String {
        [
            card.type.label,
            card.priorityLabel,
            card.title,
            card.summary,
            card.isPending ? nil : card.status.label,
        ]
        .compactMap { $0 }
        .filter { !$0.isEmpty }
        .joined(separator: ". ")
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

    private var replyComposer: some View {
        Button {
            Haptics.light()
            onAction(.requestRevision)
        } label: {
            HStack(spacing: Theme.Spacing.sm) {
                Text("Reply…")
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textTertiary)
                Spacer()
                Image(systemName: "mic.fill")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, 10)
            .contentShape(Rectangle())
            .overlay {
                RoundedRectangle(cornerRadius: Theme.Radius.input)
                    .strokeBorder(Theme.Colors.border, lineWidth: 1)
            }
        }
        .buttonStyle(.plain)
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
                    GitHubPrimaryButton(title: String(localized: "Create issue"), enabled: true) {
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
                    SecondaryAction(title: String(localized: "Decline"), tint: Theme.Colors.reject) {
                        Haptics.light()
                        onAction(.reject)
                    }

                    SecondaryAction(title: String(localized: "Revise")) {
                        Haptics.light()
                        onAction(.requestRevision)
                    }

                    SecondaryAction(title: String(localized: "Delegate")) {
                        Haptics.light()
                        onAction(.delegate)
                    }
                }

                Text(isGitHubConnected
                     ? String(localized: "Swipe right to create issue · left to decline")
                     : String(localized: "Swipe right to approve · left to decline"))
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(Theme.Colors.textTertiary)
                    .frame(maxWidth: .infinity)
                    .padding(.top, Theme.Spacing.xs)
            } else {
                HStack(spacing: 0) {
                    Button(String(localized: "Undo")) {
                        Task { await appState.webSocketService.publishRollback(cardID: card.id) }
                    }
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.Colors.interactive)

                    if card.canDelete {
                        Spacer()
                        SecondaryAction(title: String(localized: "Delete"), tint: Theme.Colors.reject) {
                            Haptics.light()
                            onAction(.delete)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

#Preview {
    DecisionCardView(
        card: DecisionCard(
            id: "preview",
            recipientUserID: "user-toru",
            senderUserID: "agent-accounting",
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
    .environmentObject(AppState())
}
