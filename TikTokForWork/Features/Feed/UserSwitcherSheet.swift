import SwiftUI

struct UserSwitcherSheet: View {
    @EnvironmentObject private var appState: AppState
    @ObservedObject var orgService: OrganizationService
    @Environment(\.dismiss) private var dismiss
    let onSelect: (User) -> Void

    @State private var showAddMember = false
    @State private var newName = ""
    @State private var newRole = ""
    @State private var newTeam = ""
    @State private var isAdding = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: Theme.Spacing.sm) {
                    ForEach(orgService.users) { user in
                        Button {
                            onSelect(user)
                            dismiss()
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(user.name)
                                        .font(.system(size: 15, weight: .medium))
                                        .foregroundStyle(Theme.Colors.textPrimary)
                                    Text(user.role)
                                        .font(.system(size: 12))
                                        .foregroundStyle(Theme.Colors.textTertiary)
                                }
                                Spacer()
                                if appState.currentUser?.id == user.id {
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

                    if showAddMember {
                        addMemberForm
                    } else {
                        Button {
                            showAddMember = true
                        } label: {
                            HStack(spacing: Theme.Spacing.sm) {
                                Image(systemName: "plus")
                                    .font(.system(size: 12, weight: .medium))
                                Text("Add member")
                                    .font(.system(size: 14))
                            }
                            .foregroundStyle(Theme.Colors.textSecondary)
                            .frame(maxWidth: .infinity)
                            .padding(Theme.Spacing.md)
                        }
                    }

                    if let errorMessage {
                        Text(errorMessage)
                            .font(Theme.TypeScale.caption)
                            .foregroundStyle(Theme.Colors.reject)
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
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(Theme.Colors.background)
    }

    private var addMemberForm: some View {
        VStack(spacing: Theme.Spacing.sm) {
            memberField("Name", text: $newName, placeholder: "Erin")
            memberField("Role", text: $newRole, placeholder: "Backend Engineer")
            memberField("Team", text: $newTeam, placeholder: "Engineering (optional)")

            PrimaryButton(
                title: isAdding ? "Adding…" : "Add to organization",
                enabled: !isAdding
                    && !newName.trimmingCharacters(in: .whitespaces).isEmpty
                    && !newRole.trimmingCharacters(in: .whitespaces).isEmpty
            ) {
                addMember()
            }

            Text("The AI routes decisions to new members by name, role, and team")
                .font(Theme.TypeScale.micro)
                .foregroundStyle(Theme.Colors.textTertiary)
        }
        .padding(Theme.Spacing.md)
        .background(Theme.Colors.surfaceRaised)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
    }

    private func memberField(_ label: String, text: Binding<String>, placeholder: String) -> some View {
        HStack(spacing: Theme.Spacing.md) {
            Text(label)
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textTertiary)
                .frame(width: 44, alignment: .leading)
            TextField(placeholder, text: text)
                .font(Theme.TypeScale.body)
                .foregroundStyle(Theme.Colors.textPrimary)
                .autocorrectionDisabled()
        }
        .padding(.vertical, Theme.Spacing.xs)
    }

    private func addMember() {
        errorMessage = nil
        isAdding = true

        Task {
            do {
                _ = try await orgService.addMember(
                    name: newName.trimmingCharacters(in: .whitespaces),
                    role: newRole.trimmingCharacters(in: .whitespaces),
                    team: newTeam.trimmingCharacters(in: .whitespaces),
                    githubUsername: ""
                )
                newName = ""
                newRole = ""
                newTeam = ""
                showAddMember = false
                Haptics.success()
            } catch {
                errorMessage = error.localizedDescription
            }
            isAdding = false
        }
    }
}
