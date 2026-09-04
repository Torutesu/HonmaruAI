import SwiftUI

/// What you have asked other people for, and what came of it.
///
/// The feed shows the decisions waiting on *you*. Everything you sent
/// disappeared into it: the answer arrived as a one-line update that scrolls
/// away, and there was nowhere to look up whether the thing you asked for on
/// Tuesday ever happened. The "Waiting 5d" chip has existed since the card was
/// built, on a screen only the recipient sees, so nobody could act on it.
///
/// This is a list, not a feed. You arrive with a question — did that get
/// approved, and if not, who is sitting on it — so the answer is the row.
struct SentView: View {
    @EnvironmentObject private var appState: AppState

    @State private var cards: [DecisionCard] = []
    @State private var detailCard: DecisionCard?
    @State private var nudging: String?
    @State private var nudged: Set<String> = []
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if cards.isEmpty {
                emptyState
            } else {
                ScrollView {
                    LazyVStack(spacing: Theme.Spacing.sm) {
                        ForEach(cards) { card in
                            row(card)
                        }
                    }
                    .padding(.horizontal, Theme.Spacing.md)
                    .padding(.vertical, Theme.Spacing.md)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.Colors.background)
        .onAppear(perform: refresh)
        .onReceive(appState.cardService.$changeCount) { _ in refresh() }
        .sheet(item: $detailCard) { card in
            CardDetailSheet(card: card)
                .presentationDetents([.medium, .large])
        }
        .alert("Error", isPresented: errorBinding) {
            Button("OK", role: .cancel) { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "")
        }
    }

    private var errorBinding: Binding<Bool> {
        Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })
    }

    private func refresh() {
        guard let userID = appState.currentUser?.id else { return }
        cards = appState.cardService.sentCards(by: userID)
    }

    private var emptyState: some View {
        VStack(spacing: Theme.Spacing.sm) {
            Text("Nothing sent yet")
                .font(Theme.TypeScale.body)
                .foregroundStyle(Theme.Colors.textSecondary)
            Text("Tell your AI what you need, and it will show up here until someone answers.")
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textTertiary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, Theme.Spacing.xl)
        }
        .accessibilityElement(children: .combine)
    }

    private func row(_ card: DecisionCard) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(alignment: .top, spacing: Theme.Spacing.sm) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(card.title)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .multilineTextAlignment(.leading)
                        .lineLimit(2)
                    Text("→ \(DisplayName.of(card.recipientUserID, in: appState.organization))")
                        .font(Theme.TypeScale.caption)
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
                Spacer(minLength: Theme.Spacing.sm)
                StatusPill(card: card)
            }

            if let issueURL = card.githubIssueURL, let url = URL(string: issueURL) {
                Link(destination: url) {
                    HStack(spacing: 4) {
                        Text(card.githubIssueNumber.map { "Issue #\($0)" } ?? String(localized: "View on GitHub"))
                        Image(systemName: "arrow.up.right").font(.system(size: 9))
                    }
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(Theme.Colors.accent)
                }
            }

            // Only when the delay has become the story. A nudge available from
            // the first hour is a nudge nobody reads.
            if card.isStale {
                nudgeButton(card)
            }
        }
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Colors.background)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.card))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.Radius.card)
                .strokeBorder(Theme.Colors.border, lineWidth: 1)
        }
        .contentShape(Rectangle())
        .onTapGesture { detailCard = card }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction(named: Text("View details")) { detailCard = card }
    }

    @ViewBuilder
    private func nudgeButton(_ card: DecisionCard) -> some View {
        if nudged.contains(card.id) {
            Text("Reminder sent")
                .font(Theme.TypeScale.micro)
                .foregroundStyle(Theme.Colors.textTertiary)
        } else {
            Button {
                Task { await nudge(card) }
            } label: {
                HStack(spacing: 5) {
                    if nudging == card.id {
                        ProgressView().controlSize(.mini)
                    } else {
                        Image(systemName: "bell").font(.system(size: 10, weight: .medium))
                    }
                    Text("Remind them")
                }
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.Colors.interactive)
            }
            .buttonStyle(.plain)
            .disabled(nudging != nil)
        }
    }

    private func nudge(_ card: DecisionCard) async {
        guard let userID = appState.currentUser?.id else { return }
        nudging = card.id
        defer { nudging = nil }
        do {
            _ = try await appState.cardService.nudge(
                cardID: card.id,
                from: userID,
                organization: appState.organization
            )
            nudged.insert(card.id)
            Haptics.light()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

/// Where a request has got to, in one word and one colour.
///
/// A row of identical-looking titles answers nothing; the whole reason to open
/// this screen is to find the one that is stuck.
struct StatusPill: View {
    let card: DecisionCard

    var body: some View {
        Text(label)
            .font(.system(size: 10, weight: .medium, design: .monospaced))
            .tracking(0.4)
            .foregroundStyle(tint)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(tint.opacity(0.12))
            .clipShape(Capsule())
            .fixedSize()
    }

    private var label: String {
        if card.isPending {
            if let days = card.waitingDays {
                return String(localized: "WAITING \(days)D")
            }
            return String(localized: "WAITING")
        }
        return card.status.label.uppercased()
    }

    private var tint: Color {
        if card.isStale { return Theme.Colors.reject }
        switch card.status {
        case .pending: return Theme.Colors.textTertiary
        case .approved, .completed: return Theme.Colors.approve
        case .rejected: return Theme.Colors.reject
        case .revised, .delegated: return Theme.Colors.interactive
        }
    }
}

#Preview {
    SentView()
        .environmentObject(AppState())
}
