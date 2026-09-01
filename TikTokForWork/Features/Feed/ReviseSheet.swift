import SwiftUI

struct ReviseSheet: View {
    let card: DecisionCard
    let onSubmit: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var note = ""
    @FocusState private var isFocused: Bool

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                Text(card.title)
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textSecondary)

                Text("What should change before this becomes a GitHub issue?")
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textTertiary)

                ZStack(alignment: .topLeading) {
                    if note.isEmpty {
                        Text("e.g. split into two issues, add acceptance criteria…")
                            .font(Theme.TypeScale.body)
                            .foregroundStyle(Theme.Colors.textTertiary)
                            .padding(.horizontal, 4)
                            .padding(.top, 8)
                    }

                    TextEditor(text: $note)
                        .font(Theme.TypeScale.body)
                        .scrollContentBackground(.hidden)
                        .frame(minHeight: 120)
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .focused($isFocused)
                }
                .padding(Theme.Spacing.md)
                .background(Theme.Colors.surfaceRaised)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.input))

                PrimaryButton(
                    title: String(localized: "Request revision"),
                    enabled: !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ) {
                    onSubmit(note.trimmingCharacters(in: .whitespacesAndNewlines))
                    dismiss()
                }

                Spacer()
            }
            .padding(Theme.Spacing.screen)
            .background(Theme.Colors.background)
            .navigationTitle("Revise")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
            .onAppear { isFocused = true }
        }
        .presentationDetents([.medium])
        .presentationBackground(Theme.Colors.surface)
        .presentationDragIndicator(.visible)
    }
}
