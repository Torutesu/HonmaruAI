import SwiftUI

struct AIInputSheet: View {
    @Binding var prompt: String
    let onSend: (String) -> Void
    @FocusState private var isFocused: Bool
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                Text("Your AI routes this to the right person as a decision card.")
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textTertiary)

                ZStack(alignment: .topLeading) {
                    if prompt.isEmpty {
                        Text("Ask Bob to approve the onboarding PR")
                            .font(Theme.TypeScale.body)
                            .foregroundStyle(Theme.Colors.textTertiary)
                            .padding(.horizontal, 4)
                            .padding(.top, 8)
                    }

                    TextEditor(text: $prompt)
                        .font(Theme.TypeScale.body)
                        .scrollContentBackground(.hidden)
                        .frame(minHeight: 100)
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .focused($isFocused)
                }
                .padding(Theme.Spacing.md)
                .background(Theme.Colors.surfaceRaised)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))

                PrimaryButton(
                    title: "Send",
                    enabled: !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ) {
                    let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !text.isEmpty else { return }
                    onSend(text)
                }

                Spacer()
            }
            .padding(Theme.Spacing.screen)
            .background(Theme.Colors.background)
            .navigationTitle("Your AI")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
            .onAppear { isFocused = true }
        }
    }
}

#Preview {
    AIInputSheet(prompt: .constant("")) { _ in }
}
