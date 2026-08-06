import SwiftUI

struct AddMemberSheet: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss

    var onAdded: ((User) -> Void)?

    @State private var name = ""
    @State private var role = ""
    @State private var githubUsername = ""
    @State private var managerID: String?
    @State private var isSaving = false
    @State private var errorMessage: String?
    @FocusState private var focusedField: Field?

    private enum Field {
        case name, role, github
    }

    private var members: [User] {
        appState.directory.members
    }

    private var canSave: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSaving
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    Text("New members get their own AI agent and can receive decision cards immediately.")
                        .font(Theme.TypeScale.caption)
                        .foregroundStyle(Theme.Colors.textTertiary)

                    field(title: "Name", text: $name, placeholder: "Full name", field: .name)
                    field(title: "Role", text: $role, placeholder: "e.g. Engineer, Designer, PM", field: .role)
                    field(title: "GitHub username", text: $githubUsername, placeholder: "Optional", field: .github)

                    managerPicker

                    if let errorMessage {
                        Text(errorMessage)
                            .font(Theme.TypeScale.label)
                            .foregroundStyle(Theme.Colors.reject)
                    }

                    PrimaryButton(title: isSaving ? "Adding…" : "Add member", enabled: canSave) {
                        save()
                    }
                }
                .padding(Theme.Spacing.screen)
            }
            .background(Theme.Colors.background)
            .navigationTitle("Add member")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
        }
        .presentationBackground(Theme.Colors.background)
        .presentationDragIndicator(.visible)
        .onAppear { focusedField = .name }
    }

    private func field(
        title: String,
        text: Binding<String>,
        placeholder: String,
        field: Field
    ) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text(title)
                .font(Theme.TypeScale.label)
                .foregroundStyle(Theme.Colors.textTertiary)

            TextField(placeholder, text: text)
                .font(Theme.TypeScale.body)
                .foregroundStyle(Theme.Colors.textPrimary)
                .textInputAutocapitalization(field == .github ? .never : .words)
                .autocorrectionDisabled(field == .github)
                .focused($focusedField, equals: field)
                .padding(Theme.Spacing.md)
                .background(Theme.Colors.surfaceRaised)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
        }
    }

    private var managerPicker: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("Reports to")
                .font(Theme.TypeScale.label)
                .foregroundStyle(Theme.Colors.textTertiary)

            Picker("Reports to", selection: $managerID) {
                Text("Nobody").tag(String?.none)
                ForEach(members) { member in
                    Text("\(member.name) · \(member.role)").tag(Optional(member.id))
                }
            }
            .pickerStyle(.menu)
            .tint(Theme.Colors.textPrimary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Theme.Spacing.md)
            .background(Theme.Colors.surfaceRaised)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))

            Text("Used by the AI to route escalations and approvals.")
                .font(Theme.TypeScale.micro)
                .foregroundStyle(Theme.Colors.textTertiary)
        }
    }

    private func save() {
        errorMessage = nil
        isSaving = true

        Task {
            do {
                let member = try await appState.directory.addMember(
                    name: name,
                    role: role,
                    managerID: managerID,
                    githubUsername: githubUsername
                )
                Haptics.success()
                onAdded?(member)
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
                Haptics.light()
            }
            isSaving = false
        }
    }
}

#Preview {
    AddMemberSheet()
        .environmentObject(AppState())
}
