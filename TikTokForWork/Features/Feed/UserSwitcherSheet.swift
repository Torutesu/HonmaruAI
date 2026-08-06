import SwiftUI

struct UserSwitcherSheet: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    let onSelect: (User) -> Void

    @State private var showAddMember = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: Theme.Spacing.sm) {
                    ForEach(appState.directory.members) { member in
                        Button {
                            onSelect(member)
                            dismiss()
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(member.name)
                                        .font(.system(size: 15, weight: .medium))
                                        .foregroundStyle(Theme.Colors.textPrimary)
                                    Text(member.role)
                                        .font(.system(size: 12))
                                        .foregroundStyle(Theme.Colors.textTertiary)
                                }
                                Spacer()
                                if appState.currentUser?.id == member.id {
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

                    SecondaryAction(title: "Add member", tint: Theme.Colors.accent) {
                        showAddMember = true
                    }
                }
                .padding(Theme.Spacing.screen)
            }
            .background(Theme.Colors.background)
            .navigationTitle("Switch user")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
            .sheet(isPresented: $showAddMember) {
                AddMemberSheet()
                    .environmentObject(appState)
            }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(Theme.Colors.background)
    }
}
