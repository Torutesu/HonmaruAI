import SwiftUI
import UIKit

/// Membership changes happen only after an explicit invite/join action.
struct TeamSettingsView: View {
    @EnvironmentObject private var appState: AppState
    @State private var inviteCode = ""
    @State private var inviteLink: URL?
    @State private var joinCode = ""
    @State private var newTeamName = ""
    @State private var renameTo = ""
    @State private var renaming = false
    @State private var busy = false
    @State private var error: String?
    @State private var joined = false
    @State private var showOrganization = false

    var body: some View {
        List {
            Section("Your team") {
                if renaming {
                    TextField("Team name", text: $renameTo)
                    Button("Save") { Task { await rename() } }.disabled(renameTo.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button("Cancel", role: .cancel) { renaming = false }
                } else {
                    HStack {
                        Text(appState.workspaceDisplayName).font(.headline)
                        Spacer()
                        if appState.canRenameWorkspace {
                            Button(appState.workspaceName == nil ? String(localized: "Name it") : String(localized: "Rename")) {
                                renameTo = appState.workspaceName ?? ""; renaming = true
                            }.font(.subheadline)
                        }
                    }
                }
                if appState.membersLoading { ProgressView("Loading teammates…") }
                ForEach(appState.workspaceMembers) { member in
                    HStack { Text(member.name); Spacer(); if member.id == appState.currentUser?.id { Text("You").foregroundStyle(.secondary) } }
                }
                if let message = appState.membersError {
                    Text(message).foregroundStyle(.secondary)
                    Button("Try again") { Task { await appState.refreshWorkspaceMembers() } }
                }
            }
            if !appState.isGuest {
                Section {
                    NavigationLink("Manage members and invitations") { TeamView().environmentObject(appState) }
                    Button("Organization") { showOrganization = true }
                }
                Section {
                    if inviteCode.isEmpty {
                        Button("Create invite link") { Task { await perform(join: false) } }
                    } else if let inviteLink {
                        // The link is what you hand over: opened, it joins
                        // or signs the person up into this team. It works
                        // for three days.
                        Text(inviteLink.absoluteString).font(.footnote).foregroundStyle(.secondary).textSelection(.enabled).lineLimit(2)
                        ShareLink(item: inviteLink, message: Text("Join my team on Honmaru AI")) { Label("Share invite link", systemImage: "link") }
                        Button("Copy link") { UIPasteboard.general.string = inviteLink.absoluteString }
                        Button("Create another") { Task { await perform(join: false) } }
                    } else {
                        Text("This deployment has no web address to put in a link yet.").foregroundStyle(.secondary)
                        Button("Create invite link") { Task { await perform(join: false) } }
                    }
                } header: { Text("Invite a teammate") } footer: { Text("Whoever opens the link within three days joins your team.") }
                Section {
                    TextField("Team name", text: $newTeamName)
                    Button("Create team") { Task { await createTeam() } }.disabled(newTeamName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                } header: { Text("Create a team") } footer: { Text("A workspace of its own, with a name, that you invite people into.") }
                Section {
                    TextField("Invite link", text: $joinCode).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    Button("Join team") { Task { await perform(join: true) } }.disabled(joinCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    if joined { Text("Team joined. Your draft is still available.").foregroundStyle(.secondary) }
                } header: { Text("Join a team") } footer: { Text("Paste the invite link your teammate sent you to switch to their team.") }
            }
            if busy { ProgressView() }
            if let error { Section { Text(error).foregroundStyle(Theme.Colors.reject) } }
        }
        .disabled(busy).navigationTitle("Team").navigationBarTitleDisplayMode(.inline)
        .task { await appState.refreshWorkspaceMembers() }
        .refreshable { await appState.refreshWorkspaceMembers() }
        .sheet(isPresented: $showOrganization) { OrgGraphView().environmentObject(appState) }
    }

    @MainActor private func perform(join: Bool) async {
        guard let base = appState.backendBaseURL, let token = SessionStore.sessionToken, let user = appState.currentUser else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            var request = URLRequest(url: base.appending(path: join ? "invites/accept" : "invites/create"))
            request.httpMethod = "POST"; request.timeoutInterval = 20
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(token, forHTTPHeaderField: "x-session-token")
            let body: [String: String] = join ? ["code": joinCode.trimmingCharacters(in: .whitespacesAndNewlines)] : ["orgId": user.teamID ?? "", "role": "member"]
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)
            guard SessionStore.sessionToken == token, appState.currentUser?.id == user.id else { return }
            let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                error = result["message"] as? String ?? String(localized: "Could not join workspace."); return
            }
            if join {
                guard let org = result["orgId"] as? String, !org.isEmpty else { throw URLError(.badServerResponse) }
                try await appState.switchToJoinedTeam(org)
                joined = true; joinCode = ""; inviteCode = ""
            } else {
                guard let code = result["code"] as? String, !code.isEmpty else { throw URLError(.badServerResponse) }
                inviteCode = code
                inviteLink = (result["link"] as? String).flatMap { URL(string: $0) }
            }
        } catch { self.error = error.localizedDescription }
    }

    @MainActor private func createTeam() async {
        guard let base = appState.backendBaseURL else { return }
        let name = newTeamName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            let made = try await TeamService.createTeam(name: name, backendBaseURL: base)
            try await appState.switchToJoinedTeam(made.orgId)
            newTeamName = ""; inviteCode = ""; inviteLink = nil
        } catch { self.error = error.localizedDescription }
    }

    @MainActor private func rename() async {
        guard let base = appState.backendBaseURL, let orgId = appState.currentUser?.teamID else { return }
        let name = renameTo.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            let named = try await TeamService.renameTeam(orgId: orgId, name: name, backendBaseURL: base)
            appState.noteWorkspaceName(named)
            renaming = false
        } catch { self.error = error.localizedDescription }
    }
}
