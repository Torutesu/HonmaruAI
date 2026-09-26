import SwiftUI

/// One workspace this person is in, as `/me` lists them.
struct WorkspaceEntry: Decodable, Identifiable, Hashable {
    let id: String
    let name: String?
    let role: String
    let founder: String?
    let mine: Bool?
    let icon: String?
    let memberCount: Int?

    var label: String {
        if let name, !name.isEmpty { return name }
        if id.contains("/") { return id }
        if mine == true { return String(localized: "Your workspace") }
        if let founder { return String(localized: "\(founder)'s team") }
        return String(localized: "A team you joined")
    }
}

enum WorkspaceDirectory {
    static func list(base: URL) async throws -> [WorkspaceEntry] {
        struct Me: Decodable { let orgs: [WorkspaceEntry]? }
        guard let token = SessionStore.sessionToken else { throw ChatService.Failure.notSignedIn }
        var request = URLRequest(url: base.appending(path: "me"))
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        request.timeoutInterval = 20
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else { throw ChatService.Failure.server(0, nil) }
        return try JSONDecoder().decode(Me.self, from: data).orgs ?? []
    }

    /// Join with an invitation: the link a teammate sent (…#/join/<code>)
    /// or the code alone. Returns the workspace joined.
    static func join(_ text: String, base: URL) async throws -> String {
        let code = inviteCode(from: text)
        return try await post("invites/accept", body: ["code": code], base: base)
    }

    static func inviteCode(from text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        for marker in ["join/", "code=", "invite="] {
            if let range = trimmed.range(of: marker, options: .backwards) {
                let rest = trimmed[range.upperBound...].prefix { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
                if !rest.isEmpty { return String(rest) }
            }
        }
        return trimmed
    }

    private static func post(_ path: String, body: [String: String], base: URL) async throws -> String {
        guard let token = SessionStore.sessionToken else { throw ChatService.Failure.notSignedIn }
        var request = URLRequest(url: base.appending(path: path))
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        let json = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode), let org = json["orgId"] as? String, !org.isEmpty else {
            throw ChatService.Failure.server((response as? HTTPURLResponse)?.statusCode ?? 0, json["message"] as? String)
        }
        return org
    }
}

/// The workspace's mark: its logo, or its first letter until it has one.
struct WorkspaceMark: View {
    let entry: WorkspaceEntry?
    let label: String
    var size: CGFloat = 36
    var body: some View {
        Group {
            if let icon = entry?.icon, let url = URL(string: icon) {
                AsyncImage(url: url) { image in image.resizable().scaledToFill() } placeholder: { letter }
            } else {
                letter
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.26, style: .continuous))
        .accessibilityHidden(true)
    }
    private var letter: some View {
        Text(String(label.prefix(1)).uppercased())
            .font(.system(size: size * 0.48, weight: .heavy))
            .foregroundStyle(Theme.Colors.background)
            .frame(width: size, height: size)
            .background(Theme.Colors.textPrimary)
    }
}

/// The mark as a button: tapped, every workspace and "Add a workspace" —
/// the phone's version of the top-left corner of a chat app.
struct WorkspaceSwitcherButton: View {
    @EnvironmentObject private var appState: AppState
    var size: CGFloat = 34
    @State private var open = false
    @State private var entries: [WorkspaceEntry] = []

    var body: some View {
        Button { open = true } label: {
            WorkspaceMark(entry: entries.first { $0.id == appState.currentUser?.teamID }, label: appState.workspaceDisplayName, size: size)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Switch workspace")
        .accessibilityValue(Text(verbatim: appState.workspaceDisplayName))
        .disabled(appState.isGuest)
        .sheet(isPresented: $open) { WorkspaceSwitcherSheet { entries = $0 }.environmentObject(appState) }
        .task(id: appState.currentUser?.teamID) {
            guard !appState.isGuest, let base = appState.backendBaseURL else { return }
            entries = (try? await WorkspaceDirectory.list(base: base)) ?? entries
        }
    }
}

struct WorkspaceSwitcherSheet: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    var onLoaded: ([WorkspaceEntry]) -> Void = { _ in }
    @State private var entries: [WorkspaceEntry] = []
    @State private var loading = true
    @State private var mode: Mode?
    @State private var text = ""
    @State private var busy = false
    @State private var error: String?

    enum Mode: Identifiable { case create, join; var id: Int { self == .create ? 0 : 1 } }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if loading && entries.isEmpty { ProgressView() }
                    ForEach(entries) { w in
                        Button { Task { await switchTo(w.id) } } label: {
                            HStack(spacing: 12) {
                                WorkspaceMark(entry: w, label: w.label, size: 40)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(verbatim: w.label).font(.body.weight(.semibold)).foregroundStyle(Theme.Colors.textPrimary)
                                    Text(members(w)).font(.caption).foregroundStyle(Theme.Colors.textSecondary)
                                }
                                Spacer()
                                if w.id == appState.currentUser?.teamID {
                                    Image(systemName: "checkmark").font(.body.weight(.semibold)).foregroundStyle(Theme.Colors.accent)
                                }
                            }
                        }
                        .accessibilityAddTraits(w.id == appState.currentUser?.teamID ? .isSelected : [])
                    }
                } header: { Text("Workspaces") }
                Section {
                    Button { text = ""; error = nil; mode = .create } label: { Label("Create a new workspace", systemImage: "plus.square") }
                    Button { text = ""; error = nil; mode = .join } label: { Label("Join with an invitation", systemImage: "person.badge.plus") }
                } header: { Text("Add a workspace") }
                if let error { Section { Text(error).foregroundStyle(Theme.Colors.reject) } }
            }
            .disabled(busy)
            .overlay { if busy { ProgressView() } }
            .navigationTitle("Workspaces").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .alert(mode == .create ? String(localized: "Create a workspace") : String(localized: "Join a workspace"), isPresented: Binding(get: { mode != nil }, set: { if !$0 { mode = nil } })) {
                TextField(mode == .create ? String(localized: "Workspace name") : String(localized: "Invitation link or code"), text: $text)
                    .textInputAutocapitalization(mode == .create ? .sentences : .never)
                    .autocorrectionDisabled(mode == .join)
                Button(mode == .create ? String(localized: "Create and open") : String(localized: "Join and open")) {
                    let which = mode
                    Task { await add(which) }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(mode == .create
                     ? String(localized: "You will be its admin. Its channels, people and emoji are its own.")
                     : String(localized: "You keep every workspace you are already in."))
            }
        }
        .task { await load() }
    }

    private func members(_ w: WorkspaceEntry) -> String {
        let n = w.memberCount ?? 1
        return n > 1 ? String(localized: "\(n) members") : String(localized: "Just you")
    }

    private func load() async {
        guard let base = appState.backendBaseURL else { return }
        loading = true
        defer { loading = false }
        do { entries = try await WorkspaceDirectory.list(base: base); onLoaded(entries) }
        catch { self.error = error.localizedDescription }
    }

    private func switchTo(_ id: String) async {
        guard id != appState.currentUser?.teamID else { dismiss(); return }
        busy = true; error = nil
        defer { busy = false }
        do { try await appState.switchToJoinedTeam(id); Haptics.success(); dismiss() }
        catch { self.error = error.localizedDescription }
    }

    private func add(_ which: Mode?) async {
        guard let which, let base = appState.backendBaseURL else { return }
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            let org: String
            switch which {
            case .create: org = try await TeamService.createTeam(name: value, backendBaseURL: base).orgId
            case .join: org = try await WorkspaceDirectory.join(value, base: base)
            }
            try await appState.switchToJoinedTeam(org)
            Haptics.success()
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}
