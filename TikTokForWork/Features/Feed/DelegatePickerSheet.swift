import SwiftUI

struct DelegatePickerSheet: View {
    @EnvironmentObject private var appState: AppState

    let card: DecisionCard
    let currentUserID: String
    let onPick: (User) -> Void

    @Environment(\.dismiss) private var dismiss

    private var candidates: [User] {
        appState.directory.candidates(excluding: currentUserID)
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
