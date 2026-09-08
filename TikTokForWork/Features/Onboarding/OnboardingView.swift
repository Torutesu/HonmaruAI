import SwiftUI

/// Guided first-run flow. Five screens, in order of persuasion:
/// value → how it works → try it (interactive swipe) → GitHub sign-in → identity.
/// Sign-in comes after the product has shown itself, and can be skipped —
/// the feed offers the connection again in context.
struct OnboardingView: View {
    @EnvironmentObject private var appState: AppState

    private enum Step: Int, CaseIterable {
        case welcome
        case routing
        case swipe
        case signIn
    }

    @State private var step: Step = .welcome

    // Sign-in step
    @State private var errorMessage: String?
    @State private var showEmailSignIn = false

    var body: some View {
        VStack(spacing: 0) {
            header
                .padding(.horizontal, Theme.Spacing.screen)
                .padding(.top, Theme.Spacing.sm)

            Group {
                switch step {
                case .welcome: welcomeStep
                case .routing: routingStep
                case .swipe: swipeStep
                case .signIn: signInStep
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.horizontal, Theme.Spacing.screen)
            .transition(.asymmetric(
                insertion: .move(edge: .trailing).combined(with: .opacity),
                removal: .move(edge: .leading).combined(with: .opacity)
            ))
            .id(step)
        }
        .appBackground()
        .animation(.easeOut(duration: 0.25), value: step)
        .sheet(isPresented: $showEmailSignIn) {
            EmailSignInSheet { session, name in
                SessionStore.sessionToken = session.token
                Task { await appState.activateEmailSession(userId: session.userId, login: session.login, orgId: session.orgId, name: name) }
            }
        }
    }

    // MARK: - Chrome

    private var header: some View {
        ZStack {
            PageDots(count: Step.allCases.count, index: step.rawValue)

            HStack {
                if step != .welcome {
                    Button(action: goBack) {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(Theme.Colors.textSecondary)
                            .frame(width: 32, height: 32)
                    }
                    .accessibilityLabel("Back")
                }
                Spacer()
            }
        }
        .frame(height: 32)
    }

    private func advance() {
        guard let next = Step(rawValue: step.rawValue + 1) else { return }
        errorMessage = nil
        step = next
    }

    private func goBack() {
        guard let previous = Step(rawValue: step.rawValue - 1) else { return }
        errorMessage = nil
        step = previous
    }

    // MARK: - 1. Welcome

    private var welcomeStep: some View {
        VStack(alignment: .leading, spacing: 0) {
            Spacer()

            AppLogo(size: 64)
                .padding(.bottom, Theme.Spacing.lg)

            Text("Decisions,\nnot messages")
                .font(.system(size: 36, weight: .medium))
                .foregroundStyle(Theme.Colors.textPrimary)
                .lineSpacing(2)
                .padding(.bottom, Theme.Spacing.md)

            Text("A work feed where nothing needs reading twice. Your AI turns your team's asks, approvals, and tasks into cards you clear in seconds.")
                .font(Theme.TypeScale.body)
                .foregroundStyle(Theme.Colors.textSecondary)
                .lineSpacing(5)
                .fixedSize(horizontal: false, vertical: true)

            Spacer()
            Spacer()

            PrimaryButton(title: String(localized: "Get started")) {
                Haptics.light()
                advance()
            }
            .padding(.bottom, Theme.Spacing.xl)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - 2. How it works

    private var routingStep: some View {
        VStack(alignment: .leading, spacing: 0) {
            stepTitle(
                "Talk only to your AI",
                subtitle: "No channels, no DMs, no inbox. Say what you need — the AIs handle who hears it, and how."
            )

            VStack(spacing: Theme.Spacing.sm) {
                routingRow(
                    icon: "person",
                    title: "You",
                    detail: "“Get the auth fix reviewed before Friday.”"
                )
                routingArrow
                routingRow(
                    icon: "sparkle",
                    title: "Your AI",
                    detail: "Reads intent, checks the org graph, picks who can decide."
                )
                routingArrow
                routingRow(
                    icon: "sparkle",
                    title: "Dana's AI",
                    detail: "Rewrites it as one clear decision, in Dana's context."
                )
                routingArrow
                routingRow(
                    icon: "person",
                    title: "Dana",
                    detail: "Sees a card. One tap: approved."
                )
            }
            .padding(.top, Theme.Spacing.lg)

            Spacer()

            PrimaryButton(title: String(localized: "Continue")) {
                Haptics.light()
                advance()
            }
            .padding(.bottom, Theme.Spacing.xl)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func routingRow(icon: String, title: LocalizedStringKey, detail: LocalizedStringKey) -> some View {
        HStack(alignment: .top, spacing: Theme.Spacing.md) {
            Image(systemName: icon)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(icon == "sparkle" ? Theme.Colors.accent : Theme.Colors.textSecondary)
                .frame(width: 20, height: 20)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Theme.Colors.textPrimary)
                Text(detail)
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(Theme.Spacing.md)
        .background(Theme.Colors.surfaceRaised)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
    }

    private var routingArrow: some View {
        Image(systemName: "arrow.down")
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(Theme.Colors.textTertiary)
    }

    // MARK: - 3. Try it

    private var swipeStep: some View {
        OnboardingSwipeDemo {
            advance()
        }
    }

    // MARK: - 4. The way in

    /// Email, and nothing else.
    ///
    /// GitHub used to be the way in here, with email underneath it as the
    /// alternative. It is gone from the phone, for two reasons that point the
    /// same way.
    ///
    /// App Review Guideline 4.8: an app that authenticates its primary account
    /// with a third-party login service must also offer one that lets a person
    /// keep their email address private. A code sent to an address cannot do
    /// that — there is no relay — so offering GitHub here means owing Apple a
    /// Sign in with Apple we do not have.
    ///
    /// And it was already the wrong default. GitHub is right for the engineer
    /// on the team and wrong for the six people who are not, and this screen is
    /// on a phone, which is where those six are. The engineer sets the
    /// repository-backed workspace up on the web and invites them; an invite
    /// code brings them into it here.
    ///
    /// Anyone already signed in with GitHub stays signed in — this is the door,
    /// not the lock.
    private var signInStep: some View {
        VStack(alignment: .leading, spacing: 0) {
            stepTitle(
                "Your decisions, where you are",
                subtitle: "We email you a six-digit code. Nothing to set up, nothing to remember, and it proves the address every notification from here depends on."
            )

            if let errorMessage {
                Text(errorMessage)
                    .font(Theme.TypeScale.label)
                    .foregroundStyle(Theme.Colors.reject)
                    .padding(.top, Theme.Spacing.lg)
            }

            Spacer()

            VStack(spacing: Theme.Spacing.sm) {
                PrimaryButton(title: String(localized: "Sign in with email"), enabled: true) {
                    showEmailSignIn = true
                }

                Button {
                    appState.activateGuestSession()
                } label: {
                    Text("Continue without signing in")
                        .font(Theme.TypeScale.label)
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
            .padding(.bottom, Theme.Spacing.xl)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Shared

    private func stepTitle(_ title: LocalizedStringKey, subtitle: LocalizedStringKey) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text(title)
                .font(.system(size: 28, weight: .medium))
                .foregroundStyle(Theme.Colors.textPrimary)
            Text(subtitle)
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textSecondary)
                .lineSpacing(4)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, Theme.Spacing.xl)
    }
}

#Preview {
    OnboardingView()
        .environmentObject(AppState())
}
