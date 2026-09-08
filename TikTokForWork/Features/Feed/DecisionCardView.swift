import SwiftUI

struct DecisionCardView: View {
    let card: DecisionCard
    let linkedRepository: String
    var isGitHubConnected: Bool = true
    let onAction: (CardActionKind) -> Void
    let onShowDetails: () -> Void

    @EnvironmentObject private var appState: AppState
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dragOffset: CGFloat = 0
    @State private var showsSource = false
    private let swipeThreshold: CGFloat = 96

    var body: some View {
        VStack(spacing: Theme.Spacing.md) {
            VStack(alignment: .leading, spacing: 20) {
                metadata
                Button(action: onShowDetails) {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(card.title)
                            .font(Theme.TypeScale.title)
                            .foregroundStyle(Theme.Colors.textPrimary)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(card.summary)
                            .font(Theme.TypeScale.body)
                            .foregroundStyle(Theme.Colors.textSecondary)
                            .lineSpacing(3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                if let original = card.originalBody, let language = card.originalLanguage {
                    TranslatedFrom(language: language, original: original)
                }
                GeneratedBlocks(card: card)
                if !card.context.isEmpty {
                    ContextInsightView(context: card.context, compact: true)
                }
                if let videoURL = card.videoURL {
                    CardVideoView(urlString: videoURL)
                        .frame(height: 200)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.image))
                }
                Divider().overlay(Theme.Colors.border)
                sender
                if let reason = card.routingReason, !reason.isEmpty {
                    Label {
                        Text(reason)
                            .font(Theme.TypeScale.caption)
                            .foregroundStyle(Theme.Colors.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    } icon: {
                        Image(systemName: "sparkles")
                            .foregroundStyle(Theme.Colors.accent)
                    }
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.Colors.accent.opacity(0.07), in: RoundedRectangle(cornerRadius: 14))
                }
                HStack {
                    Button(action: onShowDetails) {
                        Label("View details", systemImage: "arrow.up.right")
                            .font(.subheadline.weight(.medium))
                            .frame(minHeight: 44)
                    }
                    .foregroundStyle(Theme.Colors.interactive)
                    Spacer()
                    if card.showsGitHubLink(for: linkedRepository),
                       let issueURL = card.githubIssueURL, let url = URL(string: issueURL) {
                        Link(destination: url) {
                            Label("GitHub", systemImage: "arrow.up.right")
                                .font(Theme.TypeScale.caption)
                                .frame(minHeight: 44)
                        }
                        .foregroundStyle(Theme.Colors.textSecondary)
                    }
                }
                .padding(.vertical, -8)
            }
            .padding(20)
            .background(Theme.Colors.background, in: RoundedRectangle(cornerRadius: 24))
            .overlay(RoundedRectangle(cornerRadius: 24).strokeBorder(Theme.Colors.border, lineWidth: 1))
            .offset(x: dragOffset)
            .simultaneousGesture(swipeGesture)

            actionBlock
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .accessibilityElement(children: .contain)
        .accessibilityActions {
            if card.isPending {
                Button(isGitHubConnected ? String(localized: "Create issue") : String(localized: "Approve")) {
                    onAction(.createIssue)
                }
                Button(String(localized: "Decline")) { onAction(.reject) }
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

    private var metadata: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                KindTag(type: card.type)
                Spacer()
                Label(card.priorityLabel, systemImage: "circle.fill")
                    .font(.caption)
                    .foregroundStyle(priorityColor)
            }
            if let business = card.business, !business.isEmpty {
                Label(business, systemImage: "building.2")
                    .font(.caption)
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
            if let days = card.waitingDays {
                Label("Waiting \(days)d", systemImage: "clock")
                    .font(.caption)
                    .foregroundStyle(card.isStale ? Theme.Colors.reject : Theme.Colors.textSecondary)
            }
        }
    }

    private var sender: some View {
        HStack(alignment: .center, spacing: 10) {
            SenderAvatar(name: card.senderName)
            VStack(alignment: .leading, spacing: 3) {
                Text(card.senderName)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.Colors.textPrimary)
                Text(DateFormatting.relative(card.createdAt))
                    .font(.caption)
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
            Spacer(minLength: 0)
            if let app = card.sourceApp {
                Button { showsSource = true } label: {
                    SourceChip(app: app, detail: card.sourceDetail)
                        .frame(minHeight: 44)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var actionBlock: some View {
        VStack(spacing: 4) {
            if card.isPending {
                HStack(spacing: 12) {
                    Button {
                        Haptics.light()
                        onAction(.reject)
                    } label: {
                        Label("Decline", systemImage: "xmark")
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity, minHeight: 50)
                            .foregroundStyle(Theme.Colors.textSecondary)
                            .background(Theme.Colors.background, in: Capsule())
                            .overlay(Capsule().strokeBorder(Theme.Colors.border, lineWidth: 1))
                    }
                    Button {
                        Haptics.light()
                        onAction(.createIssue)
                    } label: {
                        Label(isGitHubConnected ? String(localized: "Create issue") : String(localized: "Approve"), systemImage: "checkmark")
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity, minHeight: 50)
                            .foregroundStyle(Theme.Colors.ctaText)
                            .background(Theme.Colors.ctaFill, in: Capsule())
                    }
                }
                .buttonStyle(PressFeedbackStyle())
                HStack {
                    Button { onAction(.requestRevision) } label: {
                        Label("Request revision", systemImage: "bubble.left")
                            .frame(minHeight: 44)
                    }
                    Spacer()
                    Button { onAction(.delegate) } label: {
                        Label("Delegate", systemImage: "person.badge.plus")
                            .frame(minHeight: 44)
                    }
                }
                .font(.caption.weight(.medium))
                .foregroundStyle(Theme.Colors.textSecondary)
            } else {
                HStack {
                    Label(statusLabel, systemImage: card.status == .rejected ? "xmark.circle" : "checkmark.circle")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Theme.Colors.textSecondary)
                    Spacer()
                    Button("Undo") {
                        Task { await appState.webSocketService.publishRollback(cardID: card.id) }
                    }
                    .frame(minHeight: 44)
                    .foregroundStyle(Theme.Colors.interactive)
                    if card.canDelete {
                        Button("Delete", role: .destructive) { onAction(.delete) }
                            .frame(minHeight: 44)
                    }
                }
            }
        }
    }

    private var statusLabel: String {
        if card.status == .approved, card.githubIssueURL == nil { return String(localized: "Approved") }
        return card.status.label
    }

    private var priorityColor: Color {
        switch card.priority {
        case .urgent: Theme.Colors.reject
        case .high: Theme.Colors.interactive
        default: Theme.Colors.textSecondary
        }
    }

    private var swipeGesture: some Gesture {
        DragGesture(minimumDistance: 28)
            .onChanged { value in
                guard card.isPending, abs(value.translation.width) > abs(value.translation.height) * 1.5 else { return }
                dragOffset = value.translation.width * 0.35
            }
            .onEnded { value in
                defer {
                    withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) { dragOffset = 0 }
                }
                guard card.isPending, abs(value.translation.width) > abs(value.translation.height) * 1.5 else { return }
                if value.translation.width > swipeThreshold { onAction(.createIssue) }
                if value.translation.width < -swipeThreshold { onAction(.reject) }
            }
    }
}
