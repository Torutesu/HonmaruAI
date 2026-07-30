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
    @State private var newLanguage = ""
    @State private var isAdding = false
    @State private var myLanguage = ""
    @State private var isSavingLanguage = false
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
                                    Text(subtitle(for: user))
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

                    languageBox

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
        .onAppear {
            myLanguage = appState.currentUser
                .flatMap { user in orgService.users.first { $0.id == user.id }?.language } ?? ""
        }
    }

    private func subtitle(for user: User) -> String {
        if let language = user.language, !language.isEmpty {
            return "\(user.role) · \(language)"
        }
        return user.role
    }

    // Everything this user receives — cards, digests, agent replies — is
    // translated into this language by the relay.
    private var languageBox: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("My language")
                .font(Theme.TypeScale.micro)
                .foregroundStyle(Theme.Colors.textTertiary)
                .textCase(.uppercase)
                .tracking(0.8)

            HStack(spacing: Theme.Spacing.sm) {
                TextField("en / 日本語 / Français …", text: $myLanguage)
                    .font(Theme.TypeScale.body)
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .autocorrectionDisabled()

                Button(isSavingLanguage ? "Saving…" : "Save") {
                    saveLanguage()
                }
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Theme.Colors.accent)
                .disabled(
                    isSavingLanguage
                        || myLanguage.trimmingCharacters(in: .whitespaces).isEmpty
                )
            }

            Text("Cards, digests, and agent replies arrive translated into your language")
                .font(Theme.TypeScale.micro)
                .foregroundStyle(Theme.Colors.textTertiary)
        }
        .padding(Theme.Spacing.md)
        .background(Theme.Colors.surfaceRaised)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
    }

    private func saveLanguage() {
        guard let userID = appState.currentUser?.id else { return }
        errorMessage = nil
        isSavingLanguage = true

        Task {
            do {
                _ = try await orgService.setLanguage(
                    userID: userID,
                    language: myLanguage.trimmingCharacters(in: .whitespaces)
                )
                Haptics.success()
            } catch {
                errorMessage = error.localizedDescription
            }
            isSavingLanguage = false
        }
    }

    private var addMemberForm: some View {
        VStack(spacing: Theme.Spacing.sm) {
            memberField("Name", text: $newName, placeholder: "Erin")
            memberField("Role", text: $newRole, placeholder: "Backend Engineer")
            memberField("Team", text: $newTeam, placeholder: "Engineering (optional)")
            memberField("Lang", text: $newLanguage, placeholder: "en / 日本語 (optional)")

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
                    githubUsername: "",
                    language: newLanguage.trimmingCharacters(in: .whitespaces)
                )
                newName = ""
                newRole = ""
                newTeam = ""
                newLanguage = ""
                showAddMember = false
                Haptics.success()
            } catch {
                errorMessage = error.localizedDescription
            }
            isAdding = false
        }
    }
}
