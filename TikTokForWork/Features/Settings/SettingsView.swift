import SwiftUI
import UIKit

struct SettingsView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @AppStorage("appearanceMode") private var appearanceRaw = AppearanceMode.system.rawValue

    @State private var language = ""
    @State private var isSavingLanguage = false
    @State private var languageSaved = false
    @State private var showRelaySettings = false
    @State private var errorMessage: String?

    private var appearance: AppearanceMode {
        AppearanceMode(rawValue: appearanceRaw) ?? .system
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    appearanceSection
                    languageSection
                    connectionSection
                    notificationSection
                    aboutSection

                    if let errorMessage {
                        Text(errorMessage)
                            .font(Theme.TypeScale.caption)
                            .foregroundStyle(Theme.Colors.reject)
                    }
                }
                .padding(Theme.Spacing.screen)
            }
            .appBackground()
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
        }
        .presentationBackground(Theme.Colors.background)
        .presentationDragIndicator(.visible)
        .sheet(isPresented: $showRelaySettings) {
            RelaySettingsSheet()
                .environmentObject(appState)
                .presentationDetents([.medium, .large])
                .presentationBackground(Theme.Colors.surface)
                .presentationDragIndicator(.visible)
        }
        .onAppear {
            language = appState.currentUser
                .flatMap { user in appState.orgService.users.first { $0.id == user.id }?.language } ?? ""
        }
    }

    // MARK: - Appearance

    private var appearanceSection: some View {
        section("Appearance") {
            HStack(spacing: Theme.Spacing.sm) {
                ForEach(AppearanceMode.allCases) { mode in
                    Button {
                        Haptics.light()
                        withAnimation(.easeOut(duration: 0.2)) {
                            appearanceRaw = mode.rawValue
                        }
                    } label: {
                        VStack(spacing: 6) {
                            Image(systemName: mode.icon)
                                .font(.system(size: 16, weight: .medium))
                            Text(mode.label)
                                .font(Theme.TypeScale.label)
                        }
                        .frame(maxWidth: .infinity)
                        .frame(height: 64)
                        .foregroundStyle(
                            appearance == mode ? Color.white : Theme.Colors.textSecondary
                        )
                        .background(
                            Group {
                                if appearance == mode {
                                    AnyView(Theme.Colors.accentGradient)
                                } else {
                                    AnyView(Theme.Colors.surfaceRaised)
                                }
                            }
                        )
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
                    }
                    .buttonStyle(.plain)
                }
            }

            Text("System follows your device. The whole app — cards, channels, sheets — adapts instantly.")
                .font(Theme.TypeScale.micro)
                .foregroundStyle(Theme.Colors.textTertiary)
        }
    }

    // MARK: - Language

    private var languageSection: some View {
        section("Language") {
            HStack(spacing: Theme.Spacing.sm) {
                TextField("en / 日本語 / Français …", text: $language)
                    .font(Theme.TypeScale.body)
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .autocorrectionDisabled()
                    .padding(Theme.Spacing.md)
                    .background(Theme.Colors.surfaceRaised)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous))

                Button(isSavingLanguage ? "…" : languageSaved ? "Saved" : "Save") {
                    saveLanguage()
                }
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(languageSaved ? Theme.Colors.approve : Theme.Colors.accent)
                .disabled(
                    isSavingLanguage
                        || language.trimmingCharacters(in: .whitespaces).isEmpty
                )
            }

            Text("Cards, digests, agent replies, and AI recommendations arrive translated into your language.")
                .font(Theme.TypeScale.micro)
                .foregroundStyle(Theme.Colors.textTertiary)
        }
    }

    // MARK: - Connection

    private var connectionSection: some View {
        section("Connection") {
            settingsRow(
                icon: "antenna.radiowaves.left.and.right",
                title: "Relay server",
                value: appState.relayURL
            ) {
                showRelaySettings = true
            }

            if let connection = appState.githubService.connection {
                settingsRow(
                    icon: "arrow.triangle.branch",
                    title: "GitHub repository",
                    value: connection.repository,
                    chevron: false,
                    action: nil
                )
            }

            Button {
                dismiss()
                appState.signOut()
            } label: {
                HStack {
                    Image(systemName: "rectangle.portrait.and.arrow.right")
                        .font(.system(size: 14))
                    Text("Sign out")
                        .font(Theme.TypeScale.body)
                    Spacer()
                }
                .foregroundStyle(Theme.Colors.reject)
                .padding(.vertical, Theme.Spacing.sm)
            }
        }
    }

    // MARK: - Notifications

    private var notificationSection: some View {
        section("Notifications") {
            Text("Only pending high/urgent decisions ring — never chat, notes, or digests, and never while you're connected. Manage the permission in system settings.")
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textSecondary)
                .lineSpacing(3)

            Button {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            } label: {
                Text("Open system settings")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Theme.Colors.accent)
            }
        }
    }

    // MARK: - About

    private var aboutSection: some View {
        section("About") {
            settingsRow(icon: "sparkle", title: "TikTok for Work", value: "1.0", chevron: false, action: nil)
            Text("Decisions, not messages. Your AI routes, translates, remembers, and escalates — you decide.")
                .font(Theme.TypeScale.micro)
                .foregroundStyle(Theme.Colors.textTertiary)
        }
    }

    // MARK: - Helpers

    private func section<Content: View>(
        _ title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            Text(title)
                .font(Theme.TypeScale.micro)
                .foregroundStyle(Theme.Colors.textTertiary)
                .textCase(.uppercase)
                .tracking(0.8)
            content()
        }
        .padding(Theme.Spacing.md + 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardSurface(cornerRadius: Theme.Radius.md)
    }

    private func settingsRow(
        icon: String,
        title: String,
        value: String,
        chevron: Bool = true,
        action: (() -> Void)?
    ) -> some View {
        Button {
            action?()
        } label: {
            HStack(spacing: Theme.Spacing.md) {
                Image(systemName: icon)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Theme.Colors.accent)
                    .frame(width: 22)

                Text(title)
                    .font(Theme.TypeScale.body)
                    .foregroundStyle(Theme.Colors.textPrimary)

                Spacer()

                Text(value)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(Theme.Colors.textTertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: 150, alignment: .trailing)

                if chevron {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Theme.Colors.textTertiary)
                }
            }
            .padding(.vertical, Theme.Spacing.sm)
        }
        .buttonStyle(.plain)
        .disabled(action == nil)
    }

    private func saveLanguage() {
        guard let userID = appState.currentUser?.id else { return }
        errorMessage = nil
        isSavingLanguage = true
        languageSaved = false

        Task {
            do {
                _ = try await appState.orgService.setLanguage(
                    userID: userID,
                    language: language.trimmingCharacters(in: .whitespaces)
                )
                languageSaved = true
                Haptics.success()
            } catch {
                errorMessage = error.localizedDescription
            }
            isSavingLanguage = false
        }
    }
}
