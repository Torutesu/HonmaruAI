import SwiftUI

struct NotificationsSheet: View {
    @ObservedObject var cardService: DecisionCardService
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if cardService.notifications.isEmpty {
                    VStack(spacing: Theme.Spacing.sm) {
                        Text("All caught up")
                            .font(Theme.TypeScale.body)
                            .foregroundStyle(Theme.Colors.textPrimary)
                        Text("Decisions that need you will show up here")
                            .font(Theme.TypeScale.caption)
                            .foregroundStyle(Theme.Colors.textTertiary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ScrollView {
                        VStack(spacing: Theme.Spacing.sm) {
                            ForEach(cardService.notifications) { item in
                                row(item)
                            }
                        }
                        .padding(Theme.Spacing.screen)
                    }
                }
            }
            .background(Theme.Colors.background)
            .navigationTitle("Notifications")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
        }
        .presentationBackground(Theme.Colors.surface)
        .presentationDragIndicator(.visible)
        .onAppear { markAllRead() }
    }

    private func row(_ item: NotificationItem) -> some View {
        HStack(alignment: .top, spacing: Theme.Spacing.md) {
            Circle()
                .fill(item.isUnread ? Theme.Colors.accent : Theme.Colors.surfaceRaised)
                .frame(width: 7, height: 7)
                .padding(.top, 5)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title)
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textPrimary)
                Text(item.body)
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .lineLimit(3)
                Text(DateFormatting.relative(item.createdAt))
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
            Spacer(minLength: 0)
        }
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Colors.surfaceRaised)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
    }

    private func markAllRead() {
        guard cardService.unreadNotifications > 0 else { return }
        cardService.markInboxRead()
        guard let api = appState.api, let token = SessionStore.sessionToken else { return }
        Task {
            try? await api.markAllNotificationsRead(token: token)
        }
    }
}
