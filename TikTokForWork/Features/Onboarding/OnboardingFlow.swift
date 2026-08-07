import SwiftUI

enum OnboardingStep: Int, CaseIterable {
    case welcome
    case problem
    case talkToAI
    case aiToAI
    case connectAI
    case toolsIntro
    case connectGitHub
    case connectSlack
    case connectSuite
    case buildContext
    case ready

    var isIntro: Bool { rawValue <= OnboardingStep.aiToAI.rawValue }
}

struct OnboardingFlow: View {
    @EnvironmentObject private var appState: AppState
    @State private var step: OnboardingStep = .welcome
    @State private var selectedIdentity: DemoUser = .alice

    var body: some View {
        VStack(spacing: 0) {
            topBar

            Group {
                switch step {
                case .welcome:
                    OnboardingWelcomeStep { advance() }
                case .problem:
                    OnboardingProblemStep { advance() }
                case .talkToAI:
                    OnboardingTalkToAIStep { advance() }
                case .aiToAI:
                    OnboardingAIToAIStep { advance() }
                case .connectAI:
                    OnboardingConnectAIStep(selection: $selectedIdentity) { advance() }
                case .toolsIntro:
                    OnboardingToolsIntroStep { advance() }
                case .connectGitHub:
                    OnboardingGitHubStep { advance() }
                case .connectSlack:
                    OnboardingSlackStep { advance() }
                case .connectSuite:
                    OnboardingSuiteStep { advance() }
                case .buildContext:
                    OnboardingContextStep(identity: selectedIdentity) { advance() }
                case .ready:
                    OnboardingReadyStep(identity: selectedIdentity) { finish() }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .transition(.asymmetric(
                insertion: .move(edge: .trailing).combined(with: .opacity),
                removal: .move(edge: .leading).combined(with: .opacity)
            ))
            .id(step)
        }
        .appBackground()
        .animation(.easeOut(duration: 0.25), value: step)
        .onAppear {
            if appState.preferences.hasSeenIntro, step == .welcome {
                step = .connectAI
            }
        }
    }

    private var topBar: some View {
        HStack {
            if step != .welcome, step != .ready {
                Button(action: goBack) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .frame(width: 32, height: 32)
                }
            } else {
                Color.clear.frame(width: 32, height: 32)
            }

            Spacer()

            ProgressBar(progress: progress)
                .frame(width: 96)

            Spacer()

            if step.isIntro, step != .welcome {
                Button("Skip") {
                    withAnimation { step = .connectAI }
                }
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textTertiary)
                .fixedSize()
                .frame(minWidth: 32, alignment: .trailing)
            } else {
                Color.clear.frame(width: 32, height: 32)
            }
        }
        .padding(.horizontal, Theme.Spacing.screen)
        .padding(.vertical, Theme.Spacing.sm)
    }

    private var progress: Double {
        Double(step.rawValue + 1) / Double(OnboardingStep.allCases.count)
    }

    private func advance() {
        guard let next = OnboardingStep(rawValue: step.rawValue + 1) else { return }
        withAnimation { step = next }
    }

    private func goBack() {
        guard let previous = OnboardingStep(rawValue: step.rawValue - 1) else { return }
        withAnimation { step = previous }
    }

    private func finish() {
        appState.preferences.hasSeenIntro = true
        Task {
            await appState.completeOnboarding(as: selectedIdentity.user)
        }
    }
}

struct ProgressBar: View {
    let progress: Double

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(Theme.Colors.surfaceRaised)
                Capsule()
                    .fill(Theme.Colors.textPrimary)
                    .frame(width: proxy.size.width * progress)
                    .animation(.easeOut(duration: 0.25), value: progress)
            }
        }
        .frame(height: 3)
    }
}

/// Shared layout for onboarding steps: kicker, title, subtitle, content, footer button.
struct OnboardingScaffold<Content: View>: View {
    let kicker: String
    let title: String
    let subtitle: String?
    let buttonTitle: String
    let buttonEnabled: Bool
    let secondaryTitle: String?
    let secondaryAction: (() -> Void)?
    let action: () -> Void
    let content: Content

    init(
        kicker: String,
        title: String,
        subtitle: String? = nil,
        buttonTitle: String = "Continue",
        buttonEnabled: Bool = true,
        secondaryTitle: String? = nil,
        secondaryAction: (() -> Void)? = nil,
        action: @escaping () -> Void,
        @ViewBuilder content: () -> Content
    ) {
        self.kicker = kicker
        self.title = title
        self.subtitle = subtitle
        self.buttonTitle = buttonTitle
        self.buttonEnabled = buttonEnabled
        self.secondaryTitle = secondaryTitle
        self.secondaryAction = secondaryAction
        self.action = action
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                Text(kicker)
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(Theme.Colors.textTertiary)
                    .textCase(.uppercase)
                    .tracking(0.8)

                Text(title)
                    .font(.system(size: 28, weight: .medium))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)

                if let subtitle {
                    Text(subtitle)
                        .font(Theme.TypeScale.body)
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .lineSpacing(4)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.top, Theme.Spacing.lg)
            .padding(.bottom, Theme.Spacing.xl)

            content

            Spacer(minLength: Theme.Spacing.lg)

            VStack(spacing: Theme.Spacing.sm) {
                PrimaryButton(title: buttonTitle, enabled: buttonEnabled, action: action)

                if let secondaryTitle, let secondaryAction {
                    SecondaryAction(title: secondaryTitle, action: secondaryAction)
                }
            }
            .padding(.bottom, Theme.Spacing.lg)
        }
        .padding(.horizontal, Theme.Spacing.screen)
    }
}

#Preview {
    let state = AppState()
    OnboardingFlow()
        .environmentObject(state)
        .environmentObject(state.preferences)
}
