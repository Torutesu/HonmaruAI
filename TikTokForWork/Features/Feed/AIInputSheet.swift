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
                     ? "Say anything — decisions become cards to review, updates are filed to a channel for you."
                     : "Offline mode — keyword triage: asks become cards, updates go to channels.")
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
                    title: isAIConfigured ? "Draft in background" : "Draft card",
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

                    PrimaryButton(title: "Send decision card") {
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
                            toolCalls: draft.toolCalls,
                            channelID: draft.channelID
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
        case .low: "Low"
        case .medium: "Medium"
        case .high: "High"
        case .urgent: "Urgent"
        }
    }
}

struct CardFollowUpSheet: View {
    let card: DecisionCard
    let isAIConfigured: Bool
    let onSubmit: (String) -> Void

    @State private var instruction = ""
    @FocusState private var isFocused: Bool
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                    Text(card.title)
                        .font(Theme.TypeScale.body)
                        .foregroundStyle(Theme.Colors.textPrimary)
                    Text(isAIConfigured
                         ? "Your AI updates this card with the new instruction."
                         : "Offline mode — your note is added to the card.")
                        .font(Theme.TypeScale.caption)
                        .foregroundStyle(Theme.Colors.textTertiary)
                }

                ZStack(alignment: .topLeading) {
                    if instruction.isEmpty {
                        Text("Make this urgent — deadline moved to Friday")
                            .font(Theme.TypeScale.body)
                            .foregroundStyle(Theme.Colors.textTertiary)
                            .padding(.horizontal, 4)
                            .padding(.top, 8)
                    }

                    TextEditor(text: $instruction)
                        .font(Theme.TypeScale.body)
                        .scrollContentBackground(.hidden)
                        .frame(minHeight: 80)
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .focused($isFocused)
                }
                .padding(Theme.Spacing.md)
                .background(Theme.Colors.surfaceRaised)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))

                PrimaryButton(
                    title: "Update card",
                    enabled: !instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ) {
                    let text = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !text.isEmpty else { return }
                    onSubmit(text)
                    dismiss()
                }

                Spacer()
            }
            .padding(Theme.Spacing.screen)
            .background(Theme.Colors.background)
            .navigationTitle("Ask your AI")
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
}

struct CardReplySheet: View {
    let card: DecisionCard
    let isAIConfigured: Bool
    let onSubmit: (String) -> Void

    @State private var text = ""
    @FocusState private var isFocused: Bool
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                    Text(card.title)
                        .font(Theme.TypeScale.body)
                        .foregroundStyle(Theme.Colors.textPrimary)
                    Text(isAIConfigured
                         ? "Your AI reads the intent — approve with conditions, decline with a reason, ask \(card.senderName) a question, or leave a note."
                         : "Offline mode — keyword triage: 'ok, but…' approves, '…?' asks, the rest is a note.")
                        .font(Theme.TypeScale.caption)
                        .foregroundStyle(Theme.Colors.textTertiary)
                }

                ZStack(alignment: .topLeading) {
                    if text.isEmpty {
                        Text("OK, but release after Friday's demo")
                            .font(Theme.TypeScale.body)
                            .foregroundStyle(Theme.Colors.textTertiary)
                            .padding(.horizontal, 4)
                            .padding(.top, 8)
                    }

                    TextEditor(text: $text)
                        .font(Theme.TypeScale.body)
                        .scrollContentBackground(.hidden)
                        .frame(minHeight: 90)
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .focused($isFocused)
                }
                .padding(Theme.Spacing.md)
                .background(Theme.Colors.surfaceRaised)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))

                PrimaryButton(
                    title: "Send reply",
                    enabled: !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ) {
                    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !trimmed.isEmpty else { return }
                    onSubmit(trimmed)
                    dismiss()
                }

                Spacer()
            }
            .padding(Theme.Spacing.screen)
            .background(Theme.Colors.background)
            .navigationTitle("Reply to \(card.senderName)")
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
}

struct ResendComposerSheet: View {
    let card: DecisionCard
    let isAIConfigured: Bool
    let onSubmit: (String, CardPriority) -> Void

    @State private var text: String
    @State private var priority: CardPriority
    @FocusState private var isFocused: Bool
    @Environment(\.dismiss) private var dismiss

    init(card: DecisionCard, isAIConfigured: Bool, onSubmit: @escaping (String, CardPriority) -> Void) {
        self.card = card
        self.isAIConfigured = isAIConfigured
        self.onSubmit = onSubmit
        _text = State(initialValue: card.sourceInstruction ?? card.title)
        _priority = State(initialValue: card.priority)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    if let note = card.revisionNote, !note.isEmpty {
                        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                            Text("Feedback from \(card.senderName)")
                                .font(Theme.TypeScale.label)
                                .foregroundStyle(Theme.Colors.textTertiary)
                            Text(note)
                                .font(Theme.TypeScale.body)
                                .foregroundStyle(Theme.Colors.textPrimary)
                                .lineSpacing(4)
                                .padding(Theme.Spacing.md)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Theme.Colors.surfaceRaised)
                                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                        }
                    }

                    VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                        Text("Revised instruction")
                            .font(Theme.TypeScale.label)
                            .foregroundStyle(Theme.Colors.textTertiary)

                        TextEditor(text: $text)
                            .font(Theme.TypeScale.body)
                            .scrollContentBackground(.hidden)
                            .frame(minHeight: 120)
                            .foregroundStyle(Theme.Colors.textPrimary)
                            .focused($isFocused)
                            .padding(Theme.Spacing.md)
                            .background(Theme.Colors.surfaceRaised)
                            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
                    }

                    PrioritySlider(priority: $priority)

                    PrimaryButton(
                        title: isAIConfigured ? "Draft revised card" : "Resend card",
                        enabled: !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ) {
                        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !trimmed.isEmpty else { return }
                        onSubmit(trimmed, priority)
                        dismiss()
                    }

                    Text("Goes back to \(card.senderName) after your review")
                        .font(Theme.TypeScale.micro)
                        .foregroundStyle(Theme.Colors.textTertiary)
                        .frame(maxWidth: .infinity)
                }
                .padding(Theme.Spacing.screen)
            }
            .background(Theme.Colors.background)
            .navigationTitle("Revise and resend")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
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
