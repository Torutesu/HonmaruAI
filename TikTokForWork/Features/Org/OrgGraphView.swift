import SwiftUI

/// Who is here, what they do, and who decides what.
///
/// This was four flat lists of node labels and a dump of every edge rendered as
/// `octocat  canApprove  team-web` — a debug view of a graph that only knew
/// GitHub push permissions anyway. The graph now carries what people say they
/// are responsible for and who they report to, which is what routing reads, so
/// this is where you can see it and correct it.
struct OrgGraphView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var appState: AppState

    @State private var profile: OrgProfile = .empty
    @State private var isEditing = false

    private var graph: OrganizationGraph { appState.organization }
    private var people: [OrgNode] { graph.nodes.filter { $0.kind == .person } }
    private var teams: [OrgNode] { graph.nodes.filter { $0.kind == .team } }

    var body: some View {
        NavigationStack {
            Group {
                if people.isEmpty {
                    emptyState
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                            yourProfileCard
                            peopleSection
                            if !teams.isEmpty { teamsSection }
                        }
                        .padding(Theme.Spacing.md)
                    }
                }
            }
            .background(Theme.Colors.background)
            .navigationTitle("Organization")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
            .task { await loadProfile() }
            .sheet(isPresented: $isEditing) {
                OrgProfileEditor(profile: profile, colleagues: colleagues) { saved in
                    profile = saved
                    // The graph carries the profile, so it has to be re-read
                    // before anything routes against the new answer.
                    Task { await reloadGraph() }
                }
                .environmentObject(appState)
                .presentationDetents([.medium, .large])
            }
        }
        .presentationBackground(Theme.Colors.background)
    }

    /// Everyone but you — the only people who can be your manager.
    private var colleagues: [User] {
        appState.organization.people.filter { $0.id != appState.currentUser?.id }
    }

    private var emptyState: some View {
        VStack(spacing: Theme.Spacing.sm) {
            Text("No organization yet")
                .font(Theme.TypeScale.body)
                .foregroundStyle(Theme.Colors.textSecondary)
            Text("Sign in with GitHub and pick a repository. Its collaborators are your team.")
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textTertiary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, Theme.Spacing.xl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
    }

    /// Yours, first and editable. Routing reads this line; a blank one is why
    /// "send it to whoever owns billing" cannot work.
    private var yourProfileCard: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack {
                Text("You in this team")
                    .font(Theme.TypeScale.label)
                    .foregroundStyle(Theme.Colors.textTertiary)
                Spacer()
                Button(profile.isEmpty ? String(localized: "Add") : String(localized: "Edit")) {
                    isEditing = true
                }
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Theme.Colors.interactive)
                .disabled(appState.isGuest)
            }

            if profile.isEmpty {
                Text("Your AI routes by what people are responsible for. Say what you own here, and decisions about it will find you.")
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                if let title = profile.title, !title.isEmpty {
                    Text(title)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(Theme.Colors.textPrimary)
                }
                if let responsibilities = profile.responsibilities, !responsibilities.isEmpty {
                    Text(responsibilities)
                        .font(Theme.TypeScale.caption)
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let manager = profile.managerLogin, !manager.isEmpty {
                    Text("Reports to \(DisplayName.of(manager, in: graph))")
                        .font(Theme.TypeScale.micro)
                        .foregroundStyle(Theme.Colors.textTertiary)
                }
            }
        }
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Colors.surface)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.card))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.Radius.card)
                .strokeBorder(Theme.Colors.border, lineWidth: 1)
        }
    }

    private var peopleSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("People")
                .font(Theme.TypeScale.label)
                .foregroundStyle(Theme.Colors.textTertiary)
            ForEach(people) { person in
                personRow(person)
            }
        }
    }

    private func personRow(_ person: OrgNode) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: Theme.Spacing.sm) {
                Text(person.label)
                    .font(.system(size: 15))
                    .foregroundStyle(Theme.Colors.textPrimary)
                Spacer(minLength: Theme.Spacing.xs)
                if graph.canApprove(person.id) {
                    Text("Can approve")
                        .font(.system(size: 10, weight: .medium, design: .monospaced))
                        .foregroundStyle(Theme.Colors.accent)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(Theme.Colors.accent.opacity(0.10))
                        .clipShape(Capsule())
                }
            }

            if let detail = person.detail, !detail.isEmpty {
                Text(detail)
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let manager = graph.manager(of: person.id) {
                // The same name the profile card above uses. Splitting the
                // node's "login · Role" label here gave the same person two
                // spellings on one screen — and put a quoted separator inside a
                // localised string, where the catalogue could not see the key.
                Text("Reports to \(DisplayName.of(manager.id, in: graph))")
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
        }
        .padding(.vertical, 10)
        .padding(.horizontal, Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Colors.background)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.Radius.md)
                .strokeBorder(Theme.Colors.border, lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
    }

    private var teamsSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("Teams")
                .font(Theme.TypeScale.label)
                .foregroundStyle(Theme.Colors.textTertiary)
            ForEach(teams) { team in
                Text(team.label)
                    .font(.system(size: 14, design: .monospaced))
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 8)
                    .padding(.horizontal, Theme.Spacing.md)
                    .background(Theme.Colors.surfaceRaised)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
            }
        }
    }

    private func loadProfile() async {
        guard let orgId = appState.githubService.connection?.repository,
              let base = appState.backendBaseURL else { return }
        profile = (try? await OrgProfileService.load(orgId: orgId, backendBaseURL: base)) ?? .empty
    }

    private func reloadGraph() async {
        guard let orgId = appState.githubService.connection?.repository else { return }
        let parts = orgId.split(separator: "/")
        guard parts.count == 2 else { return }
        await appState.loadOrganization(owner: String(parts[0]), repo: String(parts[1]))
    }
}

/// The one form in the app that changes how decisions are routed.
struct OrgProfileEditor: View {
    let profile: OrgProfile
    let colleagues: [User]
    let onSaved: (OrgProfile) -> Void

    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss

    @State private var title: String
    @State private var responsibilities: String
    @State private var managerLogin: String?
    @State private var isSaving = false
    @State private var errorMessage: String?

    init(profile: OrgProfile, colleagues: [User], onSaved: @escaping (OrgProfile) -> Void) {
        self.profile = profile
        self.colleagues = colleagues
        self.onSaved = onSaved
        _title = State(initialValue: profile.title ?? "")
        _responsibilities = State(initialValue: profile.responsibilities ?? "")
        _managerLogin = State(initialValue: profile.managerLogin)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(String(localized: "Design, Finance, Engineering…"), text: $title)
                } header: {
                    Text("What you do")
                }

                Section {
                    TextField(
                        String(localized: "Brand, the marketing site, vendor contracts…"),
                        text: $responsibilities,
                        axis: .vertical
                    )
                    .lineLimit(2...5)
                } header: {
                    Text("What you are responsible for")
                } footer: {
                    Text("Your teammates' AIs read this to decide what belongs to you. Plain words work best.")
                }

                Section {
                    Picker(selection: $managerLogin) {
                        Text("Nobody").tag(String?.none)
                        ForEach(colleagues, id: \.id) { colleague in
                            Text(colleague.name).tag(String?.some(colleague.id))
                        }
                    } label: {
                        Text("Reports to")
                    }
                } footer: {
                    Text("Used when something needs escalating rather than deciding.")
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.Colors.background)
            .navigationTitle("Your role")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .disabled(isSaving)
                }
            }
            .alert("Error", isPresented: errorBinding) {
                Button("OK", role: .cancel) { errorMessage = nil }
            } message: {
                Text(errorMessage ?? "")
            }
        }
    }

    private var errorBinding: Binding<Bool> {
        Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })
    }

    private func save() async {
        guard let orgId = appState.githubService.connection?.repository,
              let base = appState.backendBaseURL else {
            errorMessage = OrgProfileError.notSignedIn.localizedDescription
            return
        }
        let trimmed = OrgProfile(
            title: title.trimmingCharacters(in: .whitespacesAndNewlines),
            responsibilities: responsibilities.trimmingCharacters(in: .whitespacesAndNewlines),
            managerLogin: managerLogin
        )
        isSaving = true
        defer { isSaving = false }
        do {
            try await OrgProfileService.save(trimmed, orgId: orgId, backendBaseURL: base)
            Haptics.success()
            onSaved(trimmed)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

#Preview {
    OrgGraphView()
        .environmentObject(AppState())
}
