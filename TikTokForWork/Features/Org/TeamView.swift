import SwiftUI
import UIKit

/// Your team: who is here, what is still open into this workspace, and one
/// more way in.
///
/// Before this the phone could not mint an invite at all, and the one screen
/// that answered "who is here" read a GitHub repository's collaborators — so
/// for everybody who signed in with an email address, which is the only way in
/// on a phone, it answered nothing.
struct TeamView: View {
    @EnvironmentObject private var appState: AppState

    @State private var members: [TeamMember] = []
    @State private var editable = true
    @State private var invites: [TeamInvite] = []
    @State private var minted: String?
    @State private var role = "member"
    @State private var message: String?
    @State private var busy: String?
    @State private var confirming: String?
    @State private var loaded = false

    /// The roles an invite may grant. The label is what the person minting the
    /// code reads; the value is what the membership row gets. The server
    /// refuses anything above the caller's own standing, so this list being
    /// complete is a convenience and never an authorization.
    ///
    /// A named type rather than a tuple: Swift has no key paths into tuple
    /// members, so `ForEach(roles, id: \.id)` over an array of them does not
    /// compile.
    private struct InviteRole: Identifiable {
        let id: String
        let label: String
    }

    private static let roles: [InviteRole] = [
        InviteRole(id: "member", label: String(localized: "Member")),
        InviteRole(id: "designer", label: String(localized: "Designer")),
        InviteRole(id: "engineer", label: String(localized: "Engineer")),
        InviteRole(id: "triager", label: String(localized: "Triager")),
        InviteRole(id: "admin", label: String(localized: "Admin")),
    ]

    private var orgId: String { SessionStore.orgId ?? "" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                if let message {
                    Text(message)
                        .font(Theme.TypeScale.label)
                        .foregroundStyle(Theme.Colors.reject)
                }

                sectionTitle(String(localized: "Who is here"))
                if members.isEmpty && loaded {
                    Text(String(localized: "Nobody else yet. A code below brings somebody in."))
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
                ForEach(members) { member in
                    memberRow(member)
                }
                if !editable {
                    Text(String(localized: "This workspace's members come from a GitHub repository. Change who can push to it there."))
                        .font(Theme.TypeScale.micro)
                        .foregroundStyle(Theme.Colors.textTertiary)
                }

                if !invites.isEmpty {
                    sectionTitle(String(localized: "Codes you have out"))
                    ForEach(invites) { invite in
                        inviteRow(invite)
                    }
                }

                sectionTitle(String(localized: "Invite a teammate"))
                inviteForm
            }
            .padding(Theme.Spacing.md)
        }
        .navigationTitle(Text("Your team"))
        .refreshable { await load() }
        .task { await load() }
    }

    private func sectionTitle(_ text: String) -> some View {
        Text(text)
            .font(Theme.TypeScale.micro)
            .foregroundStyle(Theme.Colors.textTertiary)
            .padding(.top, Theme.Spacing.sm)
    }

    private func memberRow(_ member: TeamMember) -> some View {
        card {
            HStack(spacing: Theme.Spacing.sm) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(member.name)
                        .font(.system(size: 15))
                        .foregroundStyle(Theme.Colors.textPrimary)
                    Text(member.mine ? "\(roleLabel(member.role)) · \(String(localized: "you"))" : roleLabel(member.role))
                        .font(Theme.TypeScale.micro)
                        .foregroundStyle(Theme.Colors.textTertiary)
                }
                Spacer()
                if editable {
                    if busy == member.ref {
                        ProgressView()
                    } else if confirming == member.ref {
                        // Two steps, inline. A destructive action asked for
                        // once is an action asked for by a thumb on a bus.
                        HStack(spacing: Theme.Spacing.sm) {
                            Button(member.mine ? String(localized: "Leave") : String(localized: "Remove")) {
                                Task { await remove(member) }
                            }
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(Theme.Colors.reject)
                            Button(String(localized: "Keep")) { confirming = nil }
                                .font(.system(size: 14))
                                .foregroundStyle(Theme.Colors.textTertiary)
                        }
                    } else {
                        Button(member.mine ? String(localized: "Leave") : String(localized: "Remove")) {
                            message = nil
                            confirming = member.ref
                        }
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.Colors.textTertiary)
                    }
                }
            }
        }
    }

    private func inviteRow(_ invite: TeamInvite) -> some View {
        card {
            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                // A code minted above your own role is shown by reference
                // only: reading it would be a promotion you could not
                // otherwise grant.
                Text(invite.code ?? "\(invite.ref.prefix(6))…")
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .textSelection(.enabled)
                HStack {
                    Text(inviteSubtitle(invite))
                        .font(Theme.TypeScale.micro)
                        .foregroundStyle(Theme.Colors.textTertiary)
                    Spacer()
                    if let code = invite.code {
                        Button(String(localized: "Copy")) { UIPasteboard.general.string = code }
                            .font(.system(size: 14))
                            .foregroundStyle(Theme.Colors.interactive)
                    }
                    Button(String(localized: "Revoke")) {
                        Task { await revoke(invite) }
                    }
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.Colors.reject)
                    .disabled(busy == invite.ref)
                }
            }
        }
    }

    private var inviteForm: some View {
        card {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                Picker(selection: $role) {
                    ForEach(Self.roles) { option in
                        Text(option.label).tag(option.id)
                    }
                } label: {
                    Text("Their role")
                }
                .pickerStyle(.menu)

                if let minted {
                    Text(minted)
                        .font(.system(size: 13, design: .monospaced))
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .textSelection(.enabled)
                    Button(String(localized: "Copy")) { UIPasteboard.general.string = minted }
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(Theme.Colors.interactive)
                }

                Button(String(localized: "Create invite code")) {
                    Task { await mint() }
                }
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.Colors.interactive)
                .disabled(busy == "mint")
            }
        }
    }

    private func card<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        content()
            .padding(Theme.Spacing.md)
            .background(Theme.Colors.background)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.image))
            .overlay {
                RoundedRectangle(cornerRadius: Theme.Radius.image)
                    .strokeBorder(Theme.Colors.border, lineWidth: 1)
            }
    }

    private func roleLabel(_ id: String) -> String {
        Self.roles.first { $0.id == id }?.label ?? id
    }

    private func inviteSubtitle(_ invite: TeamInvite) -> String {
        let who = invite.mine ? String(localized: "yours") : invite.creator
        if invite.maxUses > 1 {
            return "\(roleLabel(invite.role)) · \(who) · \(invite.uses)/\(invite.maxUses)"
        }
        return "\(roleLabel(invite.role)) · \(who)"
    }

    private func load() async {
        guard let base = appState.backendBaseURL, !orgId.isEmpty else { loaded = true; return }
        do {
            let answer = try await TeamService.members(orgId: orgId, backendBaseURL: base)
            members = answer.members
            editable = answer.editable
            message = nil
        } catch {
            message = error.localizedDescription
        }
        // The codes are the smaller half of this screen: failing to read them
        // is not a reason to show nothing about the people.
        invites = (try? await TeamService.invites(orgId: orgId, backendBaseURL: base)) ?? []
        loaded = true
    }

    private func mint() async {
        guard let base = appState.backendBaseURL, !orgId.isEmpty else { return }
        busy = "mint"
        defer { busy = nil }
        do {
            minted = try await TeamService.mintInvite(orgId: orgId, role: role, backendBaseURL: base)
            message = nil
            await load()
        } catch {
            message = error.localizedDescription
        }
    }

    private func revoke(_ invite: TeamInvite) async {
        guard let base = appState.backendBaseURL else { return }
        busy = invite.ref
        defer { busy = nil }
        do {
            try await TeamService.revokeInvite(orgId: orgId, ref: invite.ref, backendBaseURL: base)
            message = nil
            await load()
        } catch {
            message = error.localizedDescription
        }
    }

    private func remove(_ member: TeamMember) async {
        guard let base = appState.backendBaseURL else { return }
        busy = member.ref
        defer { busy = nil; confirming = nil }
        do {
            try await TeamService.removeMember(orgId: orgId, ref: member.ref, backendBaseURL: base)
            message = nil
            // Walking out of the workspace that is on screen leaves nothing
            // here to show. The relay closes the socket for the same reason;
            // signing out is the honest end of it on a phone, where there is
            // no second workspace to fall back to.
            if member.mine {
                appState.signOut()
            } else {
                await load()
            }
        } catch {
            message = error.localizedDescription
        }
    }
}
