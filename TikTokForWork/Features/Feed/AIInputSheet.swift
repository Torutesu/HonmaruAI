import SwiftUI

struct AIInputSheet: View {
    @Binding var prompt: String
    let onSend: (String) -> Void
    @FocusState private var isFocused: Bool
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                ZStack(alignment: .topLeading) {
                    if prompt.isEmpty {
                        Text("Ask Bob to review the API spec")
                            .font(.system(size: 15))
                            .foregroundStyle(Theme.Colors.textTertiary)
                            .padding(.horizontal, Theme.Spacing.md + 4)
                            .padding(.vertical, Theme.Spacing.md + 8)
                    }

                    TextEditor(text: $prompt)
                        .font(.system(size: 15))
                        .scrollContentBackground(.hidden)
                        .padding(Theme.Spacing.md)
                        .frame(minHeight: 120)
                        .background(Theme.Colors.surfaceRaised)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .focused($isFocused)
                }

                Button {
                    let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !text.isEmpty else { return }
                    onSend(text)
                } label: {
                    Text("Send")
                        .font(.system(size: 15, weight: .medium))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(Theme.Colors.accent)
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                }
                .disabled(prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                Spacer()
            }
            .padding(Theme.Spacing.screen)
            .background(Theme.Colors.surface)
            .navigationTitle("Your AI")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .font(.system(size: 15))
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
