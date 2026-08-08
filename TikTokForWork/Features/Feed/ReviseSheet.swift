import SwiftUI

struct ReviseSheet: View {
    let card: DecisionCard
    let onSubmit: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @StateObject private var dictation = DictationService()
    @State private var note = ""
    @State private var dictationBase = ""
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
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))

                // Dictation appends to whatever is already typed rather than
                // replacing it, so switching between thumb and voice mid-reply
                // does not throw away the half you already had.
                HStack(spacing: Theme.Spacing.sm) {
                    Button {
                        if dictation.isRecording {
                            dictation.stop()
                        } else {
                            dictationBase = note
                            Task { await dictation.start() }
                        }
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: dictation.isRecording ? "stop.fill" : "mic.fill")
                                .font(.system(size: 12, weight: .semibold))
                            Text(dictation.isRecording ? "停止" : "音声で入力")
                                .font(.system(size: 13, weight: .medium))
                        }
                        .foregroundStyle(dictation.isRecording ? Theme.Colors.reject : Theme.Colors.textPrimary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .overlay { Capsule().strokeBorder(Theme.Colors.border, lineWidth: 1) }
                    }

                    if let error = dictation.errorMessage {
                        Text(error)
                            .font(Theme.TypeScale.micro)
                            .foregroundStyle(Theme.Colors.reject)
                            .lineLimit(2)
                    }

                    Spacer()
                }

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
            .onDisappear { dictation.stop() }
            .onChange(of: dictation.transcript) { _, spoken in
                guard !spoken.isEmpty else { return }
                note = dictationBase.isEmpty ? spoken : dictationBase + " " + spoken
            }
        }
        .presentationDetents([.medium])
        .presentationBackground(Theme.Colors.surface)
        .presentationDragIndicator(.visible)
    }
}
