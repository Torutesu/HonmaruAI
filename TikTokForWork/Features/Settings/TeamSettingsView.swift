import SwiftUI

/// Membership changes happen only after an explicit invite/join action.
struct TeamSettingsView: View {
    @EnvironmentObject private var appState: AppState
    @State private var inviteCode = ""
    @State private var joinCode = ""
    @State private var busy = false
    @State private var error: String?
    @State private var joined = false

    var body: some View {
        List {
            Section("Your team") {
                Text(appState.workspaceDisplayName).font(.headline)
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
                    if inviteCode.isEmpty {
                        Button("Create invite code") { Task { await perform(join: false) } }
                    } else {
                        Text(inviteCode).font(.title3.monospaced()).textSelection(.enabled)
                        ShareLink(item: inviteCode) { Label("Share invite code", systemImage: "square.and.arrow.up") }
                    }
                } header: { Text("Invite a teammate") } footer: { Text("People with this code can join your team and access its shared work.") }
                Section {
                    TextField("Invite code", text: $joinCode).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button("Join team") { Task { await perform(join: true) } }.disabled(joinCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    if joined { Text("Team joined. Your draft is still available.").foregroundStyle(.secondary) }
                } header: { Text("Join a team") } footer: { Text("Enter a code from your teammate to switch to their team.") }
            }
            if busy { ProgressView() }
            if let error { Section { Text(error).foregroundStyle(Theme.Colors.reject) } }
        }
        .disabled(busy).navigationTitle("Team").navigationBarTitleDisplayMode(.inline)
        .task { await appState.refreshWorkspaceMembers() }
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
            }
        } catch { self.error = error.localizedDescription }
    }
}
