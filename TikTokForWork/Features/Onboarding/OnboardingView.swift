import SwiftUI

/// First-run entry. One tap from cold start to a live feed: pick who you are,
/// and your AI's triaged decisions are already waiting. No account, no setup —
/// GitHub connects later, in context.
struct OnboardingView: View {
    @EnvironmentObject private var appState: AppState
    @State private var enteringUserID: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Spacer()

            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                AppLogo(size: 56)
                    .padding(.bottom, Theme.Spacing.sm)

                Text("Decisions, not messages")
                    .font(.system(size: 32, weight: .medium))
                    .foregroundStyle(Theme.Colors.textPrimary)

                Text("Talk only to your AI. It meets your teammates' AIs and routes every ask, approval, and task to whoever can act — as one card, one decision.")
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .lineSpacing(4)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.bottom, Theme.Spacing.xxl)

            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                Text("Continue as")
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(Theme.Colors.textTertiary)
                    .textCase(.uppercase)
                    .tracking(0.8)

                ForEach(DemoUser.allCases) { demoUser in
                    personaRow(demoUser)
                }
            }

            Text("No sign-up. GitHub connects later — approvals sync as Issues.")
                .font(Theme.TypeScale.micro)
                .foregroundStyle(Theme.Colors.textTertiary)
                .padding(.top, Theme.Spacing.lg)

            Spacer()
        }
        .padding(.horizontal, Theme.Spacing.screen)
        .appBackground()
    }

    private func personaRow(_ demoUser: DemoUser) -> some View {
        Button {
            enter(demoUser)
        } label: {
            HStack(spacing: Theme.Spacing.md) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(demoUser.displayName)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(Theme.Colors.textPrimary)
                    Text(demoUser.user.role)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.Colors.textTertiary)
                }

                Spacer()

                if enteringUserID == demoUser.id {
                    ProgressView()
                        .controlSize(.small)
                        .tint(Theme.Colors.textSecondary)
                } else if demoUser == .alice {
                    Text("Start here")
                        .font(Theme.TypeScale.micro)
                        .foregroundStyle(Theme.Colors.accent)
                } else {
                    Image(systemName: "arrow.right")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Theme.Colors.textTertiary)
                }
            }
            .padding(Theme.Spacing.md)
            .background(Theme.Colors.surfaceRaised)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
        }
        .buttonStyle(.plain)
        .disabled(enteringUserID != nil)
    }

    private func enter(_ demoUser: DemoUser) {
        guard enteringUserID == nil else { return }
        enteringUserID = demoUser.id
        Haptics.light()

        Task {
            await appState.activateSession(as: demoUser.user)
        }
    }
}

#Preview {
    OnboardingView()
        .environmentObject(AppState())
}
