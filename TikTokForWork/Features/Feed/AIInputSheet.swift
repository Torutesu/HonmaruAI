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
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.input))

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
    /// Everyone this card could go to. Empty when the organization has not
    /// loaded — offline, or a sign-in that has not reached GitHub yet — in which
    /// case the draft stays addressed to you rather than to someone invented.
    var recipients: [User] = []
    let onSend: (InstructionDraft) -> Void

    @State private var priority: CardPriority
    @State private var recipientUserID: String
    @Environment(\.dismiss) private var dismiss

    init(draft: InstructionDraft, recipients: [User] = [], onSend: @escaping (InstructionDraft) -> Void) {
        self.draft = draft
        self.recipients = recipients
        self.onSend = onSend
        _priority = State(initialValue: draft.priority)
        _recipientUserID = State(initialValue: draft.recipientUserID)
    }

    private var recipientName: String {
        recipients.first { $0.id == recipientUserID }?.name ?? recipientUserID
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
                        recipientRow
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
                            recipientUserID: recipientUserID,
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

    /// Who the card is for, and the one place to change it.
    ///
    /// The AI's answer is a proposal, and the review sheet is where a proposal
    /// gets accepted. It matters most when there was no AI: a draft written
    /// offline is addressed to you until you say otherwise, and this is where
    /// you say so.
    @ViewBuilder
    private var recipientRow: some View {
        if recipients.count > 1 {
            Menu {
                ForEach(recipients, id: \.id) { user in
                    Button {
                        recipientUserID = user.id
                    } label: {
                        if user.id == recipientUserID {
                            Label(user.name, systemImage: "checkmark")
                        } else {
                            Text(user.name)
                        }
                    }
                }
            } label: {
                HStack(spacing: 4) {
                    Text("→ \(recipientName)")
                    Image(systemName: "chevron.down")
                        .font(.system(size: 9, weight: .semibold))
                }
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.accent)
            }
            .accessibilityLabel(Text("Recipient"))
            .accessibilityValue(Text(recipientName))
        } else {
            Text("→ \(recipientName)")
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.accent)
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
