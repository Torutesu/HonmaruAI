import SwiftUI

struct UserSwitcherSheet: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    let onSelect: (DemoUser) -> Void

    var body: some View {
        NavigationStack {
            VStack(spacing: Theme.Spacing.sm) {
                ForEach(DemoUser.allCases) { user in
                    Button {
                        onSelect(user)
                        dismiss()
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(user.displayName)
                                    .font(.system(size: 15, weight: .medium))
                                    .foregroundStyle(Theme.Colors.textPrimary)
                                Text(user.subtitle)
                                    .font(.system(size: 12))
                                    .foregroundStyle(Theme.Colors.textTertiary)
                            }
                            Spacer()
                            if appState.currentUser?.id == user.user.id {
                                Image(systemName: "checkmark")
                                    .font(.system(size: 12))
                                    .foregroundStyle(Theme.Colors.accent)
                            }
                        }
                        .padding(Theme.Spacing.md)
                        .background(Theme.Colors.surfaceRaised)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
                    }
                }
                Spacer()
            }
            .padding(Theme.Spacing.screen)
            .background(Theme.Colors.background)
            .navigationTitle("Switch user")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
        }
        .presentationDetents([.medium])
        .presentationBackground(Theme.Colors.background)
    }
}
