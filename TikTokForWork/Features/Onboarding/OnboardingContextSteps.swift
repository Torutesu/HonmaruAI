import SwiftUI

struct OnboardingContextStep: View {
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var preferences: AppPreferences
    let identity: DemoUser
    let onContinue: () -> Void

    @State private var completedCount = 0
    @State private var buildTask: Task<Void, Never>?

    private var items: [String] {
        let repo = appState.githubService.connection?.repository ?? "your repository"
        let toolCount = preferences.connectedTools.count + (appState.githubService.hasToken ? 1 : 0)
        return [
            "Mapping your organization graph",
            "Reading \(repo)",
            "Indexing \(toolCount) connected tool\(toolCount == 1 ? "" : "s")",
            "Learning \(identity.displayName)'s role and priorities"
        ]
    }

    private var isDone: Bool { completedCount >= items.count }

    var body: some View {
        OnboardingScaffold(
            kicker: "Almost there",
            title: "Your AI is building context",
            subtitle: "It reads your org, tools, and repository so the first card it routes already makes sense.",
            buttonTitle: "Continue",
            buttonEnabled: isDone,
            action: onContinue
        ) {
            VStack(spacing: Theme.Spacing.sm) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(spacing: Theme.Spacing.md) {
                        if index < completedCount {
                            Image(systemName: "checkmark")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(Theme.Colors.approve)
                                .frame(width: 20)
                        } else if index == completedCount {
                            ProgressView()
                                .controlSize(.small)
                                .tint(Theme.Colors.textSecondary)
                                .frame(width: 20)
                        } else {
                            Circle()
                                .fill(Theme.Colors.surfaceRaised)
                                .frame(width: 6, height: 6)
                                .frame(width: 20)
                        }

                        Text(item)
                            .font(Theme.TypeScale.body)
                            .foregroundStyle(index <= completedCount ? Theme.Colors.textPrimary : Theme.Colors.textTertiary)

                        Spacer()
                    }
                    .padding(Theme.Spacing.md)
                    .background(Theme.Colors.surface)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
                }
            }
        }
        .onAppear(perform: startBuild)
        .onDisappear { buildTask?.cancel() }
    }

    private func startBuild() {
        guard completedCount == 0 else { return }
        buildTask = Task {
            for step in 1...items.count {
                try? await Task.sleep(for: .milliseconds(650))
                guard !Task.isCancelled else { return }
                withAnimation(.easeOut(duration: 0.2)) {
                    completedCount = step
                }
                Haptics.light()
            }
        }
    }
}

struct OnboardingReadyStep: View {
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var preferences: AppPreferences
    let identity: DemoUser
    let onEnter: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Spacer()

            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                Image(systemName: "sparkle")
                    .font(.system(size: 28))
                    .foregroundStyle(Theme.Colors.accent)
                    .padding(.bottom, Theme.Spacing.sm)

                Text("Your feed is live")
                    .font(.system(size: 28, weight: .medium))
                    .foregroundStyle(Theme.Colors.textPrimary)

                Text("Decisions that need you will arrive as cards. Everything else stays out of your way.")
                    .font(Theme.TypeScale.body)
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .lineSpacing(4)
            }
            .padding(.bottom, Theme.Spacing.xl)

            VStack(spacing: Theme.Spacing.sm) {
                summaryRow("You", "\(identity.displayName) · \(identity.user.role)")
                summaryRow("Your AI", "\(identity.displayName)'s AI")
                summaryRow("Repository", appState.githubService.connection?.repository ?? "Not linked")
                summaryRow("Tools", toolsSummary)
            }

            Spacer()

            PrimaryButton(title: "Enter your feed", action: onEnter)
                .padding(.bottom, Theme.Spacing.lg)
        }
        .padding(.horizontal, Theme.Spacing.screen)
    }

    private var toolsSummary: String {
        var names = ["GitHub"]
        names += WorkTool.allCases
            .filter { $0 != .github && preferences.connectedTools.contains($0) }
            .map(\.label)
        return names.joined(separator: " · ")
    }

    private func summaryRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top) {
            Text(label)
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textTertiary)
                .frame(width: 88, alignment: .leading)
            Text(value)
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(Theme.Spacing.md)
        .background(Theme.Colors.surface)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
    }
}
