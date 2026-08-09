import SwiftUI

/// Everything that has happened in this repo's feed, newest first. The backend
/// gates it by membership, so a guest is told to sign in rather than shown a
/// failure.
struct HistoryView: View {
    @EnvironmentObject private var appState: AppState
    @State private var events: [CardEvent] = []
    @State private var message: String?
    @State private var isLoading = true

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                if isLoading {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, Theme.Spacing.xl)
                } else if let message {
                    Text(message)
                        .font(Theme.TypeScale.body)
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.top, Theme.Spacing.xl)
                } else if events.isEmpty {
                    Text(String(localized: "Nothing has happened yet."))
                        .font(Theme.TypeScale.body)
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .padding(.top, Theme.Spacing.xl)
                } else {
                    ForEach(events) { event in
                        row(event)
                    }
                }
            }
            .padding(Theme.Spacing.md)
        }
        .navigationTitle(Text("History"))
        .task { await load() }
    }

    private func row(_ event: CardEvent) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(event.headline)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Theme.Colors.textPrimary)
                Spacer()
                Text(RelativeTime.since(event.createdAt))
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
            Text(event.snapshot?.title ?? event.cardId)
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textSecondary)
                .lineLimit(2)
            if let actor = event.actorUserId {
                Text(actor)
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
        }
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Colors.background)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.image))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.Radius.image)
                .strokeBorder(Theme.Colors.border, lineWidth: 1)
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        guard let repository = appState.githubService.connection?.repository,
              let base = appState.backendBaseURL else {
            message = String(localized: "Sign in with GitHub to see your team's history.")
            return
        }
        let parts = repository.split(separator: "/")
        guard parts.count == 2 else {
            message = String(localized: "Sign in with GitHub to see your team's history.")
            return
        }
        do {
            events = try await HistoryService.fetch(
                owner: String(parts[0]), repo: String(parts[1]), backendBaseURL: base
            )
            message = nil
        } catch {
            message = error.localizedDescription
        }
    }
}

/// Coarse relative time — "3m", "2h", "5d". Precision beyond this is noise in an
/// activity list.
enum RelativeTime {
    static func since(_ iso: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = formatter.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let date else { return "" }
        let seconds = Int(Date().timeIntervalSince(date))
        if seconds < 60 { return String(localized: "just now") }
        if seconds < 3600 { return "\(seconds / 60)m" }
        if seconds < 86_400 { return "\(seconds / 3600)h" }
        return "\(seconds / 86_400)d"
    }
}
