import SwiftUI

/// What your AI should know about you. This rides along with every routing
/// request, so it changes who your instructions reach.
struct ContextView: View {
    @EnvironmentObject private var appState: AppState
    @State private var draft: String = ""
    /// What you do, as the router reads it. Yours to say — "店長", "CFO",
    /// "head of suppliers" — and saved when you leave the field.
    @State private var role: String = ""
    @State private var roleSaved: String?
    @State private var roleError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Your role")
                    .font(Theme.TypeScale.label)
                    .foregroundStyle(Theme.Colors.textTertiary)
                TextField(String(localized: "e.g. store manager, CFO, designer"), text: $role)
                    .font(Theme.TypeScale.body)
                    .padding(Theme.Spacing.sm)
                    .background(Theme.Colors.surface)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.image))
                    .overlay { RoundedRectangle(cornerRadius: Theme.Radius.image).strokeBorder(Theme.Colors.border, lineWidth: 1) }
                    .onSubmit { Task { await saveRole() } }
                if let roleError {
                    Text(roleError).font(Theme.TypeScale.caption).foregroundStyle(Theme.Colors.reject)
                } else {
                    Text("What gets routed to you first. In your own words — anyone can change theirs.")
                        .font(Theme.TypeScale.caption)
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }

            Text(String(localized: "Tell your AI how you work — what you own, what you care about, who to involve. It uses this when routing your instructions."))
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textSecondary)

            TextEditor(text: $draft)
                .font(Theme.TypeScale.body)
                .scrollContentBackground(.hidden)
                .padding(Theme.Spacing.sm)
                .frame(minHeight: 220)
                .background(Theme.Colors.surface)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.image))
                .overlay {
                    RoundedRectangle(cornerRadius: Theme.Radius.image)
                        .strokeBorder(Theme.Colors.border, lineWidth: 1)
                }

            Spacer()
        }
        .padding(Theme.Spacing.md)
        .navigationTitle(Text("Context"))
        .onAppear { draft = appState.userContext }
        .task { await loadRole() }
        .onDisappear {
            appState.userContext = draft
            Task { await appState.publishUserContext() }
            Task { await saveRole() }
        }
    }

    @MainActor private func loadRole() async {
        guard let base = appState.backendBaseURL, let orgId = appState.currentUser?.teamID, !appState.isGuest else { return }
        if let current = await ProfileService.role(orgId: orgId, backendBaseURL: base) {
            role = current
            roleSaved = current
        }
    }

    @MainActor private func saveRole() async {
        let wanted = role.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !wanted.isEmpty, wanted != roleSaved,
              let base = appState.backendBaseURL, let orgId = appState.currentUser?.teamID, !appState.isGuest else { return }
        do {
            try await ProfileService.setRole(wanted, orgId: orgId, backendBaseURL: base)
            roleSaved = wanted
            roleError = nil
        } catch {
            roleError = error.localizedDescription
        }
    }
}
