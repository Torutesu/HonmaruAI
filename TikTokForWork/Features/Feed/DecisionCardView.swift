import SwiftUI

/// The card surface and two decisions follow the approved Figma frame. Content
/// stays natural-height at accessibility sizes instead of being clipped.
struct DecisionCardView: View {
    let card: DecisionCard
    let linkedRepository: String
    var isGitHubConnected = true
    var showsActions = true
    let onAction: (CardActionKind) -> Void
    let onShowDetails: () -> Void
    @EnvironmentObject private var appState: AppState
    @Environment(\.locale) private var locale
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .title2) private var titleSize = 23.0
    @ScaledMetric(relativeTo: .body) private var bodySize = 12.0
    @ScaledMetric(relativeTo: .caption) private var captionSize = 9.5
    @State private var showSource = false

    private var sender: WorkspaceMember? { appState.workspaceMembers.first { $0.id == card.senderUserID } }
    private var senderName: String { card.requestedBy?.name ?? sender?.name ?? DisplayName.of(card.senderUserID, in: appState.organization) }
    private var senderRole: String? { card.requestedBy?.role ?? sender?.role }
    private var quote: String? { card.requestedBy?.quote ?? card.originalBody ?? card.sourceInstruction }
    var body: some View {
        VStack(spacing: 26) {
            VStack(alignment: .leading, spacing: 14) {
                cardHeader
                Button(action: onShowDetails) {
                    Text(card.title).font(.system(size: titleSize, weight: .bold)).tracking(-0.5)
                        .foregroundStyle(Theme.Colors.textPrimary).frame(maxWidth: .infinity, alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true)
                }.buttonStyle(.plain)
                Text(card.summary).font(.system(size: bodySize)).lineSpacing(3)
                    .foregroundStyle(Theme.Colors.textSecondary).fixedSize(horizontal: false, vertical: true)
                if let source = card.sourceApp {
                    Button { showSource = true } label: {
                        HStack(spacing: 8) {
                            Image(systemName: sourceSymbol(source)).font(.system(size: 17)).frame(width: 26, height: 26)
                                .background(Theme.Colors.surface, in: Circle())
                            Text(sourceDisplay(source)).font(.system(size: bodySize, weight: .semibold))
                            Text(appState.isGuest ? String(localized: "Sample source") : String(localized: "Source")).font(.system(size: captionSize))
                        }
                        .foregroundStyle(Theme.Colors.textPrimary).padding(.horizontal, 10).padding(.vertical, 6)
                        .background(Theme.Colors.background, in: Capsule()).overlay(Capsule().stroke(Theme.Colors.border, lineWidth: 1))
                    }.buttonStyle(.plain)
                }
                VStack(alignment: .leading, spacing: 14) {
                    Text("Requested By").font(.system(size: captionSize, design: .monospaced)).foregroundStyle(Theme.Colors.textSecondary)
                    HStack(alignment: .top, spacing: 9) {
                        RequestAvatar(name: senderName, url: card.requestedBy?.avatarUrl ?? sender?.avatarUrl, size: 32)
                        VStack(alignment: .leading, spacing: 8) {
                            ViewThatFits(in: .horizontal) {
                                HStack(spacing: 8) { Text(senderName).font(.system(size: bodySize, weight: .semibold)); requesterMeta }
                                VStack(alignment: .leading, spacing: 4) { Text(senderName).font(.system(size: bodySize, weight: .semibold)); requesterMeta }
                            }
                            if let quote, !quote.isEmpty {
                                Text("“\(quote)”").font(.system(size: captionSize)).lineSpacing(2).foregroundStyle(Theme.Colors.textSecondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            Button { if card.sourceApp != nil { showSource = true } else { onShowDetails() } } label: {
                                HStack(spacing: 5) { Text("View original"); Image(systemName: "chevron.right") }.font(.system(size: captionSize, weight: .semibold))
                            }.buttonStyle(.plain).foregroundStyle(Theme.Colors.textSecondary)
                        }
                    }
                }
                if let recommendation = card.recommendation, let label = recommendationLabel(recommendation.action) {
                    VStack(alignment: .leading, spacing: 9) {
                        HStack(spacing: 6) {
                            Image(systemName: "sparkles").foregroundStyle(Theme.Colors.accent)
                            (Text("Recommended: ") + Text(label).foregroundColor(Theme.Colors.accent))
                                .font(.system(size: bodySize + 2, weight: .medium))
                        }
                        if let reason = recommendation.reason, !reason.isEmpty {
                            Text(reason).font(.system(size: captionSize)).lineSpacing(3).foregroundStyle(Theme.Colors.textSecondary)
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(13)
                        .background(Theme.Colors.accent.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
                }
            }
            .padding(18)
            .background(Theme.Colors.background, in: RoundedRectangle(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).stroke(Theme.Colors.border, lineWidth: 1))
            .contextMenu {
                Button("View details", systemImage: "doc.text", action: onShowDetails)
                if card.type != .notification {
                    Button("Reply", systemImage: "arrowshape.turn.up.left") { onAction(.reply) }
                    Button("Request revision", systemImage: "pencil") { onAction(.requestRevision) }
                    Button("Delegate", systemImage: "person.badge.plus") { onAction(.delegate) }
                }
            }
            if showsActions, card.isPending { DecisionCardActions(card: card, onAction: onAction) }
        }
        .sheet(isPresented: $showSource) {
            if let app = card.sourceApp { SourceSheet(app: app, detail: card.sourceDetail, card: card).presentationDetents([.medium, .large]) }
        }
    }
    @ViewBuilder private var cardHeader: some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 8) {
                kindLabel
                priorities
            }.foregroundStyle(Theme.Colors.textSecondary)
        } else {
            HStack(spacing: 6) {
                kindLabel
                Spacer(minLength: 4)
                priorities
            }.foregroundStyle(Theme.Colors.textSecondary)
        }
    }
    private var kindLabel: some View {
        Text(appState.isGuest ? String(localized: "Decisions · Demo") : String(localized: "Decisions"))
            .font(.system(size: captionSize, design: .monospaced)).fixedSize(horizontal: false, vertical: true)
    }
    private var priorities: some View {
        HStack(spacing: 6) {
            priorityLegend("Low", color: Theme.Colors.approve)
            priorityLegend("Medium", color: .orange)
            priorityLegend("High", color: Theme.Colors.reject)
        }
    }
    private var requesterMeta: some View {
        HStack(spacing: 5) { Text(relativeTime); if let role = senderRole, !role.isEmpty { Text("•"); Text(role) } }
            .font(.system(size: captionSize - 1)).foregroundStyle(Theme.Colors.textSecondary)
    }
    private var relativeTime: String {
        let formatter = RelativeDateTimeFormatter(); formatter.unitsStyle = .short; formatter.locale = locale
        let minutes = max(1, Int(Date().timeIntervalSince(card.createdAt) / 60))
        return formatter.localizedString(from: minutes < 60 ? DateComponents(minute: -minutes) : minutes < 1440 ? DateComponents(hour: -(minutes / 60)) : DateComponents(day: -(minutes / 1440)))
    }
    private func priorityLegend(_ text: LocalizedStringKey, color: Color) -> some View {
        HStack(spacing: 3) { Circle().fill(color).frame(width: 5, height: 5); Text(text).font(.system(size: captionSize, design: .monospaced)).fixedSize() }
    }
    private func recommendationLabel(_ action: String) -> String? {
        switch action { case "approve": String(localized: "Approve"); case "decline": String(localized: "Decline"); case "revise": String(localized: "Request revision"); default: nil }
    }
    private func sourceSymbol(_ source: String) -> String { switch source.lowercased() { case "github": "chevron.left.forwardslash.chevron.right"; case "slack": "number"; case "notion": "doc.text"; case "gmail", "email": "envelope"; default: "link" } }
    private func sourceDisplay(_ source: String) -> String { switch source.lowercased() { case "github": "GitHub"; case "slack": "Slack"; case "notion": "Notion"; case "gmail": "Gmail"; default: source.capitalized } }
}


/// Kept outside the card scroll region in Home so both decisions remain
/// reachable on a small screen or with accessibility text sizes.
struct DecisionCardActions: View {
    let card: DecisionCard
    let onAction: (CardActionKind) -> Void
    @EnvironmentObject private var appState: AppState
    var body: some View {
        HStack(spacing: 14) {
            decisionButton(String(localized: "Decline"), symbol: "xmark", primary: false) { onAction(.reject) }
            decisionButton(primaryTitle, symbol: card.type == .revision ? "arrowshape.turn.up.left" : "checkmark", primary: true) { onAction(primaryAction) }
        }
        .disabled(!appState.isGuest && appState.connectionState != .connected)
    }
    private func decisionButton(_ title: String, symbol: String, primary: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 25, weight: .medium)).frame(width: 60, height: 60)
                .foregroundStyle(primary ? Theme.Colors.ctaText : Theme.Colors.textSecondary)
                .background(primary ? Theme.Colors.ctaFill : Theme.Colors.background, in: Circle())
                .overlay(Circle().stroke(primary ? Color.clear : Theme.Colors.border, lineWidth: 1.5))
        }.buttonStyle(PressFeedbackStyle()).accessibilityLabel(title)
    }
    private var primaryAction: CardActionKind { card.type == .approval ? .createIssue : card.type == .revision ? .reply : .acknowledge }
    private var primaryTitle: String {
        switch card.type {
        case .approval: String(localized: "Approve")
        case .revision: String(localized: "Reply")
        case .notification: String(localized: "Acknowledge")
        case .task, .delegation: String(localized: "Mark complete")
        }
    }
}

struct RequestAvatar: View {
    let name: String
    let url: String?
    var size: CGFloat = 38
    var body: some View {
        Group {
            if let url, let imageURL = URL(string: url), ["https", "http"].contains(imageURL.scheme ?? "") {
                AsyncImage(url: imageURL) { image in image.resizable().scaledToFill() } placeholder: { initials }
            } else { initials }
        }.frame(width: size, height: size).clipShape(Circle())
    }
    private var initials: some View {
        Text(String(name.prefix(1))).font(.system(size: size * 0.4, weight: .medium)).foregroundStyle(Theme.Colors.textSecondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity).background(Theme.Colors.surfaceRaised)
    }
}
