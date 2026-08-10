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
    private let webAuth = WebAuthContextProvider()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                Text(String(localized: "Connect the places your work arrives. Your AI reads them and shows you only what needs a decision."))
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textSecondary)

                ForEach(connectors) { connector in
                    row(connector)
                }

                if let message {
                    Text(message)
                        .font(Theme.TypeScale.label)
                        .foregroundStyle(Theme.Colors.reject)
                }
            }
            .padding(Theme.Spacing.md)
        }
        .navigationTitle(Text("Connectors"))
        .task { await load() }
    }

    private func row(_ connector: Connector) -> some View {
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
        .padding(Theme.Spacing.md)
        .background(Theme.Colors.background)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.image))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.Radius.image)
                .strokeBorder(Theme.Colors.border, lineWidth: 1)
        }
    }

    private func load() async {
        guard let base = appState.backendBaseURL else { return }
        do {
            connectors = try await ConnectorService.list(backendBaseURL: base)
            message = nil
        } catch {
            message = String(localized: "Could not load your connectors.")
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
            let session = ASWebAuthenticationSession(
                url: url, callbackURLScheme: "tiktokforwork"
            ) { _, _ in
                continuation.resume(returning: true)
            }
            session.presentationContextProvider = webAuth
            session.prefersEphemeralWebBrowserSession = false
            session.start()
        }
    }
}
