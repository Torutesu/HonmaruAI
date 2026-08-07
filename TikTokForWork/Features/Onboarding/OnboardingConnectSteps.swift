import SwiftUI

struct OnboardingConnectAIStep: View {
    @Binding var selection: DemoUser
    let onContinue: () -> Void

    var body: some View {
        OnboardingScaffold(
            kicker: "Connect AI",
            title: "Meet your AI",
            subtitle: "Pick who you are in the demo org. A dedicated agent is linked to each person.",
            action: onContinue
        ) {
            VStack(spacing: Theme.Spacing.sm) {
                ForEach(DemoUser.allCases) { user in
                    Button {
                        Haptics.light()
                        selection = user
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(user.displayName)
                                    .font(.system(size: 15, weight: .medium))
                                    .foregroundStyle(Theme.Colors.textPrimary)
                                Text(user.subtitle)
                                    .font(Theme.TypeScale.label)
                                    .foregroundStyle(Theme.Colors.textTertiary)
                            }
                            Spacer()
                            if selection == user {
                                Image(systemName: "checkmark")
                                    .font(.system(size: 12, weight: .semibold))
                                    .foregroundStyle(Theme.Colors.accent)
                            }
                        }
                        .padding(Theme.Spacing.md)
                        .background(Theme.Colors.surfaceRaised)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
                        .overlay(
                            RoundedRectangle(cornerRadius: Theme.Radius.md)
                                .strokeBorder(selection == user ? Theme.Colors.accent : .clear, lineWidth: 1)
                        )
                    }
                    .buttonStyle(.plain)
                }

                HStack(spacing: Theme.Spacing.sm) {
                    Image(systemName: "sparkle")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.Colors.accent)
                    Text("\(selection.displayName)'s AI is ready to work for you")
                        .font(Theme.TypeScale.caption)
                        .foregroundStyle(Theme.Colors.textSecondary)
                    Spacer()
                }
                .padding(.top, Theme.Spacing.sm)
            }
        }
    }
}

struct OnboardingToolsIntroStep: View {
    let onContinue: () -> Void

    var body: some View {
        OnboardingScaffold(
            kicker: "Connect tools",
            title: "Your AI acts through your tools",
            subtitle: "Approved decisions don't stop at a card — your AI executes them where work actually happens.",
            action: onContinue
        ) {
            VStack(spacing: Theme.Spacing.sm) {
                ForEach(WorkTool.allCases) { tool in
                    HStack(spacing: Theme.Spacing.md) {
                        Image(systemName: tool.icon)
                            .font(.system(size: 14))
                            .foregroundStyle(Theme.Colors.textSecondary)
                            .frame(width: 20)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(tool.label)
                                .font(.system(size: 15, weight: .medium))
                                .foregroundStyle(Theme.Colors.textPrimary)
                            Text(tool.blurb)
                                .font(Theme.TypeScale.label)
                                .foregroundStyle(Theme.Colors.textTertiary)
                                .lineLimit(2)
                        }
                        Spacer()
                    }
                    .padding(Theme.Spacing.md)
                    .background(Theme.Colors.surface)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
                }
            }
        }
    }
}

struct OnboardingSlackStep: View {
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var preferences: AppPreferences
    @State private var isConnecting = false
    let onContinue: () -> Void

    private var isConnected: Bool {
        preferences.connectedTools.contains(.slack)
    }

    var body: some View {
        OnboardingScaffold(
            kicker: "Connect tools · 2 of 5",
            title: "Connect Slack",
            subtitle: "Your AI reads team activity for context and posts decision summaries where people expect them.",
            buttonTitle: isConnected ? "Continue" : "Skip for now",
            action: onContinue
        ) {
            VStack(spacing: Theme.Spacing.sm) {
                HStack(spacing: Theme.Spacing.md) {
                    Image(systemName: WorkTool.slack.icon)
                        .font(.system(size: 16))
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .frame(width: 40, height: 40)
                        .background(Theme.Colors.surfaceRaised)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))

                    VStack(alignment: .leading, spacing: 2) {
                        Text("honmaru-hq.slack.com")
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(Theme.Colors.textPrimary)
                        Text(isConnected ? "Connected" : "Workspace found")
                            .font(Theme.TypeScale.label)
                            .foregroundStyle(isConnected ? Theme.Colors.approve : Theme.Colors.textTertiary)
                    }

                    Spacer()

                    if isConnecting {
                        ProgressView()
                            .controlSize(.small)
                            .tint(Theme.Colors.textSecondary)
                    } else if isConnected {
                        Image(systemName: "checkmark")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Theme.Colors.approve)
                    }
                }
                .padding(Theme.Spacing.md)
                .background(Theme.Colors.surface)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))

                if !isConnected {
                    Button(action: connect) {
                        Text("Connect Slack")
                            .font(.system(size: 15, weight: .medium))
                            .frame(maxWidth: .infinity)
                            .frame(height: 44)
                            .background(Theme.Colors.surfaceRaised)
                            .foregroundStyle(Theme.Colors.textPrimary)
                            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
                    }
                    .disabled(isConnecting)
                }

                Text("Demo connection — Slack actions are simulated in this MVP.")
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(Theme.Colors.textTertiary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, Theme.Spacing.xs)
            }
        }
    }

    private func connect() {
        isConnecting = true
        Task {
            try? await Task.sleep(for: .milliseconds(700))
            preferences.connectedTools.insert(.slack)
            isConnecting = false
            Haptics.success()
        }
    }
}

struct OnboardingSuiteStep: View {
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var preferences: AppPreferences
    let onContinue: () -> Void

    private let tools: [WorkTool] = [.notion, .gmail, .calendar]

    var body: some View {
        OnboardingScaffold(
            kicker: "Connect tools · 3–5 of 5",
            title: "Connect your workspace",
            subtitle: "Docs, mail, and calendar give your AI the context to route and execute well. You can add these later.",
            action: onContinue
        ) {
            VStack(spacing: Theme.Spacing.sm) {
                ForEach(tools) { tool in
                    let connected = preferences.connectedTools.contains(tool)
                    Button {
                        Haptics.light()
                        preferences.toggle(tool)
                    } label: {
                        HStack(spacing: Theme.Spacing.md) {
                            Image(systemName: tool.icon)
                                .font(.system(size: 14))
                                .foregroundStyle(Theme.Colors.textSecondary)
                                .frame(width: 20)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(tool.label)
                                    .font(.system(size: 15, weight: .medium))
                                    .foregroundStyle(Theme.Colors.textPrimary)
                                Text(connected ? "Connected" : "Not connected")
                                    .font(Theme.TypeScale.label)
                                    .foregroundStyle(connected ? Theme.Colors.approve : Theme.Colors.textTertiary)
                            }
                            Spacer()
                            Text(connected ? "Disconnect" : "Connect")
                                .font(Theme.TypeScale.caption)
                                .foregroundStyle(connected ? Theme.Colors.textTertiary : Theme.Colors.accent)
                        }
                        .padding(Theme.Spacing.md)
                        .background(Theme.Colors.surface)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
                    }
                    .buttonStyle(.plain)
                }

                Text("Demo connections — actions on these tools are simulated in this MVP.")
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(Theme.Colors.textTertiary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, Theme.Spacing.xs)
            }
        }
    }
}
