import SwiftUI

struct OnboardingWelcomeStep: View {
    let onContinue: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Spacer()

            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                AppLogo(size: 56)
                    .padding(.bottom, Theme.Spacing.md)

                Text("Honmaru AI")
                    .font(.system(size: 34, weight: .medium))
                    .foregroundStyle(Theme.Colors.textPrimary)

                Text("TikTok for Work")
                    .font(Theme.TypeScale.body)
                    .foregroundStyle(Theme.Colors.textSecondary)

                Text("Decisions, not messages")
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textTertiary)
            }

            Spacer()

            PrimaryButton(title: "Get started", action: onContinue)
                .padding(.bottom, Theme.Spacing.lg)
        }
        .padding(.horizontal, Theme.Spacing.screen)
    }
}

struct OnboardingProblemStep: View {
    let onContinue: () -> Void

    private let problems = [
        "Channels multiply, attention doesn't",
        "Important decisions drown in notifications",
        "Nobody knows who should decide",
        "The same thing gets explained five times"
    ]

    var body: some View {
        OnboardingScaffold(
            kicker: "Why Honmaru",
            title: "Work chat is where decisions go to die",
            subtitle: "Slack-style messaging made everyone reachable and nothing decidable.",
            action: onContinue
        ) {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                ForEach(problems, id: \.self) { problem in
                    HStack(alignment: .top, spacing: Theme.Spacing.sm) {
                        Image(systemName: "xmark")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(Theme.Colors.reject)
                            .padding(.top, 4)
                        Text(problem)
                            .font(Theme.TypeScale.body)
                            .foregroundStyle(Theme.Colors.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Theme.Spacing.md)
                    .background(Theme.Colors.surface)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
                }
            }
        }
    }
}

struct OnboardingTalkToAIStep: View {
    let onContinue: () -> Void

    var body: some View {
        OnboardingScaffold(
            kicker: "How it works",
            title: "You only talk to your AI",
            subtitle: "No channels, no DMs, no inboxes. Tell your AI what you need — it figures out who should hear it.",
            action: onContinue
        ) {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                bubble("Ask Bob to review the onboarding PR before Friday", from: "You")
                bubble("Routing to Bob's AI — he has review authority on Onboarding v2.", from: "Your AI", accent: true)
            }
        }
    }

    private func bubble(_ text: String, from: String, accent: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text(from)
                .font(Theme.TypeScale.micro)
                .foregroundStyle(accent ? Theme.Colors.accent : Theme.Colors.textTertiary)
            Text(text)
                .font(Theme.TypeScale.body)
                .foregroundStyle(Theme.Colors.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Theme.Spacing.md)
        .background(Theme.Colors.surfaceRaised)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
    }
}

struct OnboardingAIToAIStep: View {
    let onContinue: () -> Void

    var body: some View {
        OnboardingScaffold(
            kicker: "How it works",
            title: "Your AI talks to their AI",
            subtitle: "The receiving AI turns your intent into a decision card shaped for its owner — their role, priorities, and authority.",
            action: onContinue
        ) {
            VStack(spacing: Theme.Spacing.sm) {
                routeRow("Your AI", "sparkle")
                Image(systemName: "arrow.down")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Theme.Colors.textTertiary)
                routeRow("Bob's AI", "sparkle")
                Image(systemName: "arrow.down")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Theme.Colors.textTertiary)

                VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                    Text("Approval · High")
                        .font(Theme.TypeScale.micro)
                        .foregroundStyle(Theme.Colors.textTertiary)
                    Text("Review onboarding PR")
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(Theme.Colors.textPrimary)
                    Text("Deadline Friday · You have review authority")
                        .font(Theme.TypeScale.caption)
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Theme.Spacing.md)
                .background(Theme.Colors.surface)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
            }
        }
    }

    private func routeRow(_ name: String, _ icon: String) -> some View {
        HStack(spacing: Theme.Spacing.sm) {
            Image(systemName: icon)
                .font(.system(size: 12))
                .foregroundStyle(Theme.Colors.accent)
            Text(name)
                .font(Theme.TypeScale.body)
                .foregroundStyle(Theme.Colors.textPrimary)
            Spacer()
        }
        .padding(Theme.Spacing.md)
        .background(Theme.Colors.surfaceRaised)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
    }
}
