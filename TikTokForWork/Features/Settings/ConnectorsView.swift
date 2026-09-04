import UIKit
import SwiftUI
import AuthenticationServices

/// Each person connects their own accounts. The app never sees a credential —
/// it opens a Composio-hosted authorization page and the backend holds the
/// connection against this user.
struct ConnectorsView: View {
    @EnvironmentObject private var appState: AppState
    @State private var connectors: [Connector] = []
    @State private var message: String?
    @State private var busy: String?
    @State private var databases: [NotionDatabase] = []
    @State private var chosenDatabase: String?
    /// Where mail has to be sent to reach this person. Email is the one
    /// connector you do not authorize — you forward to it — so without the
    /// address on screen there was no way to use it at all.
    @State private var inboundAddress: String?
    @State private var copiedAddress = false
    private let webAuth = WebAuthContextProvider()
    /// The authorization session has to be held while it is on screen. As a
    /// local inside `authorize` it went out of scope the moment `start()`
    /// returned, and a deallocated session takes its callback with it — the
    /// continuation below then never resumes and the connect button spins
    /// forever.
    @State private var authSession: ASWebAuthenticationSession?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                Text(String(localized: "Connect the places your work arrives. Your AI reads them and shows you only what needs a decision."))
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textSecondary)

                ForEach(connectors) { connector in
                    row(connector)
                }

                if let inboundAddress { emailCard(inboundAddress) }

                if let message {
                    Text(message)
                        .font(Theme.TypeScale.label)
                        .foregroundStyle(Theme.Colors.reject)
                }
            }
            .padding(Theme.Spacing.md)
        }
        .navigationTitle(Text("Connectors"))
        .refreshable { await load() }
        .task { await load() }
    }

    /// Not a row in the list above: there is nothing to connect. This is an
    /// address to forward mail to, and the only thing to do with it is copy it.
    private func emailCard(_ address: String) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text("Forward mail here")
                .font(.system(size: 15))
                .foregroundStyle(Theme.Colors.textPrimary)
            Text(address)
                .font(.system(size: 13, design: .monospaced))
                .foregroundStyle(Theme.Colors.textSecondary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            Text("Mail from an address you have not vouched for arrives as something to read, never as something to approve.")
                .font(Theme.TypeScale.micro)
                .foregroundStyle(Theme.Colors.textTertiary)
                .fixedSize(horizontal: false, vertical: true)
            Button(copiedAddress ? String(localized: "Copied") : String(localized: "Copy address")) {
                UIPasteboard.general.string = address
                copiedAddress = true
                Haptics.success()
            }
            .font(.system(size: 14, weight: .medium))
            .foregroundStyle(Theme.Colors.interactive)
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

    private func row(_ connector: Connector) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(connector.label)
                    .font(.system(size: 15))
                    .foregroundStyle(Theme.Colors.textPrimary)
                Spacer()
                if busy == connector.id {
                    ProgressView()
                } else if connector.isConnected {
                    Text(String(localized: "Connected"))
                        .font(Theme.TypeScale.micro)
                        .foregroundStyle(Theme.Colors.textTertiary)
                } else {
                    Button(String(localized: "Connect")) {
                        Task { await connect(connector) }
                    }
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Theme.Colors.interactive)
                }
            }

            if connector.id == "notion", connector.isConnected {
                VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                    Text(String(localized: "Where decisions are recorded"))
                        .font(Theme.TypeScale.micro)
                        .foregroundStyle(Theme.Colors.textTertiary)
                    if databases.isEmpty {
                        Text(String(localized: "No databases shared with Honmaru AI yet. Share one in Notion, then pull to refresh."))
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.Colors.textSecondary)
                    } else {
                        ForEach(databases) { db in
                            Button {
                                Task { await choose(db) }
                            } label: {
                                HStack {
                                    Text(db.title)
                                        .font(.system(size: 14))
                                        .foregroundStyle(Theme.Colors.textPrimary)
                                    Spacer()
                                    if chosenDatabase == db.id {
                                        Image(systemName: "checkmark")
                                            .font(.system(size: 12, weight: .semibold))
                                            .foregroundStyle(Theme.Colors.interactive)
                                    }
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .padding(.top, Theme.Spacing.sm)
            }
        }
        .padding(Theme.Spacing.md)
        .background(Theme.Colors.background)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.image))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.Radius.image)
                .strokeBorder(Theme.Colors.border, lineWidth: 1)
        }
    }

    private func load() async {
        ConnectorService.clearLegacyNotionDatabaseDefaults()
        guard let base = appState.backendBaseURL else { return }
        do {
            connectors = try await ConnectorService.list(backendBaseURL: base)
            message = nil
        } catch {
            message = String(localized: "Could not load your connectors.")
        }
        // Nil on a deployment with no inbound domain, which is most of them —
        // and then nothing about email appears at all, rather than an address
        // that goes nowhere.
        inboundAddress = await ConnectorService.inboundEmailAddress(backendBaseURL: base)
        if connectors.contains(where: { $0.id == "notion" && $0.isConnected }) {
            databases = (try? await ConnectorService.notionDatabases(backendBaseURL: base)) ?? []
            chosenDatabase = try? await ConnectorService.notionDatabaseConfig(backendBaseURL: base)
        }
    }

    private func choose(_ db: NotionDatabase) async {
        guard let base = appState.backendBaseURL else { return }
        do {
            try await ConnectorService.setNotionDatabase(db.id, backendBaseURL: base)
            chosenDatabase = db.id
            message = nil
        } catch {
            message = String(localized: "Could not save your choice.")
        }
    }

    private func connect(_ connector: Connector) async {
        guard let base = appState.backendBaseURL else { return }
        busy = connector.id
        defer { busy = nil }
        do {
            let url = try await ConnectorService.connectURL(for: connector.id, backendBaseURL: base)
            _ = try await authorize(url)
            await load()
        } catch {
            message = String(localized: "Could not start the connection.")
        }
    }

    /// The authorization page finishes on a Composio-hosted URL, so there is no
    /// custom scheme to wait for — the session ends when the user closes it, and
    /// the real answer comes from re-reading the status afterwards.
    private func authorize(_ url: URL) async throws -> Bool {
        try await withCheckedThrowingContinuation { continuation in
            var resumed = false
            let session = ASWebAuthenticationSession(
                url: url, callbackURLScheme: "tiktokforwork"
            ) { _, _ in
                // Cancelling is not an error here: whether the connection was
                // made is decided by re-reading the status, not by what the
                // browser handed back.
                guard !resumed else { return }
                resumed = true
                continuation.resume(returning: true)
            }
            session.presentationContextProvider = webAuth
            session.prefersEphemeralWebBrowserSession = false
            authSession = session
            // A session that refuses to start never calls back, and a
            // continuation nobody resumes is a spinner that never stops.
            if !session.start(), !resumed {
                resumed = true
                authSession = nil
                continuation.resume(returning: false)
            }
        }
    }
}
