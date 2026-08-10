import SwiftUI

struct AIInputSheet: View {
    @Binding var prompt: String
    let isAIConfigured: Bool
    let onSubmit: (String, CardPriority) -> Void

    @State private var priority: CardPriority = .medium
    @FocusState private var isFocused: Bool
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                Text(isAIConfigured
                     ? String(localized: "Your AI drafts a decision card in the background — keep scrolling while it works.")
                     : String(localized: "Offline mode — local routing with your priority setting."))
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textTertiary)

                ZStack(alignment: .topLeading) {
                    if prompt.isEmpty {
                        Text("Ask Bob to review the onboarding PR before Friday")
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

                PrioritySlider(priority: $priority)

                PrimaryButton(
                    title: isAIConfigured ? String(localized: "Draft in background") : String(localized: "Draft card"),
                    enabled: !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ) {
                    submit()
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
        }
        .onAppear { isFocused = true }
    }

    private func submit() {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        onSubmit(text, priority)
        dismiss()
    }
}

struct DraftReviewSheet: View {
    let draft: InstructionDraft
    let onSend: (InstructionDraft) -> Void

    @State private var priority: CardPriority
    @Environment(\.dismiss) private var dismiss

    init(draft: InstructionDraft, onSend: @escaping (InstructionDraft) -> Void) {
        self.draft = draft
        self.onSend = onSend
        _priority = State(initialValue: draft.priority)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    if !draft.toolCalls.isEmpty {
                        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                            Text("Tool calls")
                                .font(Theme.TypeScale.label)
                                .foregroundStyle(Theme.Colors.textTertiary)
                            ForEach(draft.toolCalls) { call in
                                ToolCallChip(call: call)
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                        Text(draft.title)
                            .font(Theme.TypeScale.title)
                            .foregroundStyle(Theme.Colors.textPrimary)
                        Text("→ \(draft.recipientName)")
                            .font(Theme.TypeScale.caption)
                            .foregroundStyle(Theme.Colors.accent)
                        Text(draft.summary)
                            .font(Theme.TypeScale.body)
                            .foregroundStyle(Theme.Colors.textSecondary)
                            .lineSpacing(4)
                        if !draft.context.isEmpty {
                            ContextInsightView(context: draft.context)
                        }
                    }

                    HStack {
                        LabelChip(text: priorityLabel)
                        LabelChip(text: draft.cardType.label)
                        ForEach(draft.labels, id: \.self) { label in
                            LabelChip(text: label)
                        }
                    }

                    PrioritySlider(priority: $priority)

                    PrimaryButton(title: String(localized: "Send decision card")) {
                        let finalDraft = InstructionDraft(
                            id: draft.id,
                            sourceText: draft.sourceText,
                            recipientUserID: draft.recipientUserID,
                            cardType: draft.cardType,
                            title: draft.title,
                            summary: draft.summary,
                            context: draft.context,
                            priority: priority,
                            agentRoute: draft.agentRoute,
                            routingReason: draft.routingReason,
                            labels: draft.labels,
                            toolCalls: draft.toolCalls
                        )
                        onSend(finalDraft)
                        dismiss()
                    }
                }
                .padding(Theme.Spacing.screen)
            }
            .background(Theme.Colors.background)
            .navigationTitle("Review card")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Discard") { dismiss() }
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
        }
    }

    private var priorityLabel: String {
        switch priority {
        case .low: String(localized: "Low")
        case .medium: String(localized: "Medium")
        case .high: String(localized: "High")
        case .urgent: String(localized: "Urgent")
        }
    }
}

#Preview {
    AIInputSheet(
        prompt: .constant(""),
        isAIConfigured: true,
        onSubmit: { _, _ in }
    )
}
