import SwiftUI

/// What your AI should know about you. This rides along with every routing
/// request, so it changes who your instructions reach.
struct ContextView: View {
    @EnvironmentObject private var appState: AppState
    @State private var draft: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            Text(String(localized: "Tell your AI how you work — what you own, what you care about, who to involve. It uses this when routing your instructions."))
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textSecondary)

            TextEditor(text: $draft)
                .font(Theme.TypeScale.body)
                .scrollContentBackground(.hidden)
                .padding(Theme.Spacing.sm)
                .frame(minHeight: 220)
                .background(Theme.Colors.surface)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.input))
                .overlay {
                    RoundedRectangle(cornerRadius: Theme.Radius.input)
                        .strokeBorder(Theme.Colors.border, lineWidth: 1)
                }

            Spacer()
        }
        .padding(Theme.Spacing.md)
        .navigationTitle(Text("Context"))
        .onAppear { draft = appState.userContext }
        .onDisappear {
            appState.userContext = draft
            Task { await appState.publishUserContext() }
        }
    }
}
