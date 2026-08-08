import SwiftUI

/// A6 — iOS inset-grouped settings on white cards, radius 16, hairline
/// separators. This is where the account actions live now; they used to hide
/// behind an ellipsis menu on the feed.
struct YouView: View {
    @EnvironmentObject private var appState: AppState

    @State private var showUserSwitcher = false
    @State private var showOrgGraph = false
    @State private var showConnectGitHub = false

    var body: some View {
        ScrollView {
            VStack(spacing: Theme.Spacing.md) {
                header

                group {
                    row("あなたの AI", value: appState.aiService.isConfigured ? "接続済み" : "未設定")
                    row("リレー接続", value: relayHost)
                    row("GitHub", value: appState.githubService.connection?.repository ?? "未接続") {
                        showConnectGitHub = true
                    }
                }

                // Rows from the "Core App v3" mock whose features do not exist
                // on this branch. They are shown dimmed and labelled rather than
                // wired to nothing, so the screen never implies it can do
                // something it cannot.
                group {
                    pendingRow("プラン")
                    pendingRow("API キー")
                    pendingRow("コンテキスト")
                }

                group {
                    pendingRow("ロールバック履歴")
                    pendingRow("通知")
                    pendingRow("クラシック表示を既定にする")
                }

                group {
                    row("組織", value: "") { showOrgGraph = true }
                    row("メンバーを切り替える", value: appState.currentUser?.name ?? "") {
                        showUserSwitcher = true
                    }
                }

                group {
                    // Opens iOS Settings rather than keeping a second language
                    // list in the app: the system setting is what actually
                    // decides, so duplicating it here would only be able to lie.
                    row("言語", value: currentLanguage) {
                        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                        UIApplication.shared.open(url)
                    }
                    row("バージョン", value: versionString)
                }

                Button("サインアウト") {
                    appState.signOut()
                }
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Theme.Colors.reject)
                .padding(.top, Theme.Spacing.sm)
            }
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.top, Theme.Spacing.lg)
            .padding(.bottom, Theme.Spacing.xxl)
        }
        .sheet(isPresented: $showUserSwitcher) {
            UserSwitcherSheet { user in
                Task { await appState.switchUser(to: user.user) }
            }
            .environmentObject(appState)
        }
        .sheet(isPresented: $showOrgGraph) { OrgGraphView() }
        .sheet(isPresented: $showConnectGitHub) {
            ConnectGitHubSheet(context: .settings)
                .environmentObject(appState)
                .presentationDetents([.medium, .large])
                .presentationBackground(Theme.Colors.surface)
        }
    }

    /// The language the app actually resolved to, not the device's preference
    /// list — those differ whenever the app does not ship the top choice.
    private var currentLanguage: String {
        guard let code = Bundle.main.preferredLocalizations.first else { return "—" }
        return Locale.current.localizedString(forLanguageCode: code)?.capitalized ?? code
    }

    private var versionString: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "—"
        let build = info?["CFBundleVersion"] as? String ?? "—"
        return "\(short) (\(build))"
    }

    private var relayHost: String {
        appState.relayURL
            .replacingOccurrences(of: "ws://", with: "")
            .replacingOccurrences(of: "wss://", with: "")
    }

    private var header: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Text(String(appState.currentUser?.name.prefix(1) ?? "?"))
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.Colors.textSecondary)
                .frame(width: 40, height: 40)
                .background(Theme.Colors.surfaceRaised)
                .clipShape(Circle())

            VStack(alignment: .leading, spacing: 1) {
                Text(appState.currentUser?.name ?? "")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textPrimary)
                Text(appState.currentUser?.role ?? "")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.Colors.textTertiary)
            }

            Spacer()
        }
        .padding(Theme.Spacing.md)
        .background(Theme.Colors.background)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.image))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.Radius.image)
                .strokeBorder(Theme.Colors.border, lineWidth: 1)
        }
    }

    private func group<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(spacing: 0) { content() }
            .background(Theme.Colors.background)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.image))
            .overlay {
                RoundedRectangle(cornerRadius: Theme.Radius.image)
                    .strokeBorder(Theme.Colors.border, lineWidth: 1)
            }
    }

    /// A row from the design that has no feature behind it yet. Dimmed, inert,
    /// and labelled — the alternative is a control that silently does nothing.
    private func pendingRow(_ title: String) -> some View {
        HStack {
            Text(title)
                .font(.system(size: 15))
                .foregroundStyle(Theme.Colors.textTertiary)
            Spacer()
            Text("準備中")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Theme.Colors.textTertiary)
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background(Theme.Colors.surfaceRaised)
                .clipShape(Capsule())
        }
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.vertical, 13)
    }

    @ViewBuilder
    private func row(_ title: String, value: String, action: (() -> Void)? = nil) -> some View {
        let content = HStack {
            Text(title)
                .font(.system(size: 15))
                .foregroundStyle(Theme.Colors.textPrimary)
            Spacer()
            Text(value)
                .font(.system(size: 14))
                .foregroundStyle(Theme.Colors.textTertiary)
                .lineLimit(1)
            if action != nil {
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
        }
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.vertical, 13)

        if let action {
            Button(action: action) { content }.buttonStyle(.plain)
        } else {
            content
        }
    }
}

#Preview {
    YouView()
        .environmentObject(AppState())
}
