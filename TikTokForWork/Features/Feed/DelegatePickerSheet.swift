import SwiftUI

struct DelegatePickerSheet: View {
    let card: DecisionCard
    let currentUserID: String
    let onPick: (User) -> Void

    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss

    private var candidates: [User] {
        appState.organization.nodes
            .filter { $0.kind == .person && $0.id != currentUserID }
            .map { node in
                let parts = node.label.split(separator: "·", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
                let name = parts.first ?? node.label
                let role = parts.count > 1 ? parts[1] : "Member"
                return User(id: node.id, name: name, role: role, teamID: nil, githubUsername: node.id)
            }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(card.title)
                        .font(Theme.TypeScale.caption)
                        .foregroundStyle(Theme.Colors.textSecondary)
                } header: {
                    Text("Delegate decision")
                }

                Section("Send to") {
                    ForEach(candidates, id: \.id) { user in
                        Button {
                            onPick(user)
                            dismiss()
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(user.name)
                                    .font(Theme.TypeScale.body)
                                    .foregroundStyle(Theme.Colors.textPrimary)
                                Text(user.role)
                                    .font(Theme.TypeScale.caption)
                                    .foregroundStyle(Theme.Colors.textTertiary)
                            }
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.Colors.background)
            .navigationTitle("Delegate")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
        }
        .presentationDetents([.medium])
        .presentationBackground(Theme.Colors.surface)
        .presentationDragIndicator(.visible)
    }
}
