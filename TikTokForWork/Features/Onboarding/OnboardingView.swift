import SwiftUI

/// Welcome follows the HonmaruAI Final Screen composition. Authentication is
/// presented separately so its loading/error state never replaces the welcome.
struct OnboardingView: View {
    @EnvironmentObject private var appState: AppState
    @State private var showEmail = false
    @ScaledMetric(relativeTo: .largeTitle) private var headingSize = 32

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(spacing: 0) {
                    VStack(spacing: 24) {
                        AppLogo(size: 64)
                        Text("Welcome to\nHonmaru AI")
                            .font(.system(size: headingSize, weight: .semibold))
                            .tracking(-1).multilineTextAlignment(.center)
                            .foregroundStyle(Theme.Colors.textPrimary)
                        Text("Your AI teammate that helps you make the right decisions, every time.")
                            .font(.subheadline).lineSpacing(5)
                            .foregroundStyle(Theme.Colors.textSecondary)
                            .multilineTextAlignment(.center).frame(maxWidth: 310)
                    }
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: max(360, geometry.size.height - 252))
                    VStack(spacing: 10) {
                        PrimaryButton(title: String(localized: "Get started")) { showEmail = true }
                        Button { showEmail = true } label: {
                            Text("I already have an account").font(.subheadline)
                                .frame(maxWidth: .infinity, minHeight: 48)
                                .overlay(Capsule().stroke(Theme.Colors.border, lineWidth: 1))
                        }.buttonStyle(.plain)
                        HStack(spacing: 24) {
                            Button("Try the demo") { appState.activateGuestSession() }
                        }.font(.footnote).foregroundStyle(Theme.Colors.textSecondary)
                            .frame(minHeight: 44)
                    }.padding(.horizontal, 20).padding(.bottom, 12)
                }.frame(minHeight: geometry.size.height)
            }.background(Theme.Colors.surface.ignoresSafeArea())
        }
        .sheet(isPresented: $showEmail) {
            EmailSignInSheet { session, name in
                Task { await appState.activateEmailSession(login: session.login, orgId: session.orgId, name: name, sessionToken: session.token, accountID: session.userID) }
            }.environmentObject(appState).presentationDetents([.large])
        }

        .tint(Theme.Colors.textPrimary)
    }
}
