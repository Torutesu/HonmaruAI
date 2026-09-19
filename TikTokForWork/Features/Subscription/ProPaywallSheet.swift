import RevenueCat
import SwiftUI

/// The paywall the app presents everywhere.
///
/// Products, prices, purchases, and entitlements come from RevenueCat. The presentation is
/// first-party so App Review and customers always see the plan title, renewal period, price,
/// restore control, and legal links together regardless of a remotely edited paywall template.
struct ProPaywallSheet: View {
    @EnvironmentObject private var subscriptions: SubscriptionService
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            SubscriptionLegalLinks()
                .background(Theme.Colors.background)
        }
            .task { await subscriptions.loadOfferings() }
    }

    @ViewBuilder
    private var content: some View {
        if subscriptions.currentOffering != nil {
            FallbackPaywallView()
        } else if subscriptions.isLoadingOfferings {
            loadingState
        } else {
            FallbackPaywallView()
        }
    }

    private var loadingState: some View {
        VStack(spacing: Theme.Spacing.md) {
            ProgressView()
                .tint(Theme.Colors.accent)
            Text("Loading plans…")
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textTertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .appBackground()
    }
}

/// A first-party legal footer shared by the account subscription screen and every
/// paywall state. Keeping it outside RevenueCat's hosted view means a remote template
/// cannot cover or remove the links App Review and customers need.
struct SubscriptionLegalLinks: View {
    private let termsURL = URL(string: "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/")!
    private let privacyURL = URL(string: "https://honmaru-web.pages.dev/privacy.html")!

    var body: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Link("Terms of Use", destination: termsURL)
            Text("·")
                .accessibilityHidden(true)
            Link("Privacy Policy", destination: privacyURL)
        }
        .font(Theme.TypeScale.micro)
        .foregroundStyle(Theme.Colors.textSecondary)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, Theme.Spacing.screen)
        .padding(.vertical, Theme.Spacing.sm)
    }
}

/// Native paywall used when the RevenueCat-hosted one can't be rendered.
///
/// It reads the same `Offering` / `Package` objects, so prices still come from the store —
/// never hardcode them, they differ per storefront and currency.
struct FallbackPaywallView: View {
    @EnvironmentObject private var subscriptions: SubscriptionService
    @Environment(\.dismiss) private var dismiss
    @State private var selectedPackage: Package?

    var body: some View {
        VStack(spacing: 0) {
            header

            if subscriptions.availablePackages.isEmpty {
                unavailableState
            } else {
                packageList
                purchaseControls
            }
        }
        .appBackground()
        .onChange(of: subscriptions.availablePackages.map(\.identifier), initial: true) {
            selectedPackage = selectedPackage
                ?? subscriptions.annualPackage
                ?? subscriptions.availablePackages.first
        }
        .alert("Subscription", isPresented: errorBinding) {
            Button("OK", role: .cancel) { subscriptions.clearError() }
        } message: {
            Text(subscriptions.errorMessage ?? "")
        }
    }

    private var header: some View {
        VStack(spacing: Theme.Spacing.sm) {
            HStack {
                Spacer()
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.Colors.textTertiary)
                        .frame(width: 32, height: 32)
                }
            }

            Text("honmaruai Pro")
                .font(Theme.TypeScale.title)
                .foregroundStyle(Theme.Colors.textPrimary)

            Text("Unlimited AI routing, the org graph, and priority delivery.")
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, Theme.Spacing.lg)
        }
        .padding(.horizontal, Theme.Spacing.screen)
        .padding(.bottom, Theme.Spacing.lg)
    }

    private var packageList: some View {
        VStack(spacing: Theme.Spacing.sm) {
            ForEach(subscriptions.availablePackages, id: \.identifier) { package in
                packageRow(package)
            }
        }
        .padding(.horizontal, Theme.Spacing.screen)
    }

    private func packageRow(_ package: Package) -> some View {
        let isSelected = selectedPackage?.identifier == package.identifier

        return Button {
            selectedPackage = package
            Haptics.light()
        } label: {
            HStack(spacing: Theme.Spacing.md) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(RevenueCatConfig.planName(forProductID: package.storeProduct.productIdentifier))
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(Theme.Colors.textPrimary)
                    Text(subscriptionPeriodText(for: package))
                        .font(Theme.TypeScale.micro)
                        .foregroundStyle(Theme.Colors.textTertiary)
                        .lineLimit(1)
                }

                Spacer(minLength: 0)

                Text(package.storeProduct.localizedPriceString)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Theme.Colors.textPrimary)
            }
            .padding(Theme.Spacing.md)
            .background(Theme.Colors.surfaceRaised)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.md)
                    .strokeBorder(isSelected ? Theme.Colors.accent : .clear, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
        }
        .buttonStyle(.plain)
    }

    private func subscriptionPeriodText(for package: Package) -> String {
        guard let period = package.storeProduct.subscriptionPeriod else {
            return package.storeProduct.localizedDescription
        }

        return switch (period.value, period.unit) {
        case (1, .day): String(localized: "1 day")
        case (1, .week): String(localized: "1 week")
        case (1, .month): String(localized: "1 month")
        case (1, .year): String(localized: "1 year")
        case (_, .day): String(format: String(localized: "%lld days"), Int64(period.value))
        case (_, .week): String(format: String(localized: "%lld weeks"), Int64(period.value))
        case (_, .month): String(format: String(localized: "%lld months"), Int64(period.value))
        case (_, .year): String(format: String(localized: "%lld years"), Int64(period.value))
        @unknown default: package.storeProduct.localizedDescription
        }
    }

    private var purchaseControls: some View {
        VStack(spacing: Theme.Spacing.sm) {
            Spacer(minLength: Theme.Spacing.lg)

            PrimaryButton(
                title: subscriptions.isPurchasing ? String(localized: "Purchasing…") : String(localized: "Continue"),
                enabled: selectedPackage != nil && !subscriptions.isPurchasing
            ) {
                guard let selectedPackage else { return }
                Task {
                    if await subscriptions.purchase(selectedPackage) {
                        Haptics.success()
                        dismiss()
                    }
                }
            }

            SecondaryAction(title: subscriptions.isRestoring ? String(localized: "Restoring…") : String(localized: "Restore purchases")) {
                Task {
                    if await subscriptions.restorePurchases() {
                        Haptics.success()
                        dismiss()
                    }
                }
            }

            Text("Subscriptions renew automatically until cancelled. Manage or cancel anytime in Settings.")
                .font(Theme.TypeScale.micro)
                .foregroundStyle(Theme.Colors.textTertiary)
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, Theme.Spacing.screen)
        .padding(.bottom, Theme.Spacing.lg)
    }

    private var unavailableState: some View {
        VStack(spacing: Theme.Spacing.md) {
            Spacer()
            Text("Plans aren't available right now")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Theme.Colors.textPrimary)
            Text("Check your connection, then try again.")
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textTertiary)
            Button("Try again") {
                Task { await subscriptions.loadOfferings(force: true) }
            }
            .font(Theme.TypeScale.caption)
            .foregroundStyle(Theme.Colors.accent)
            Spacer()
            SecondaryAction(title: String(localized: "Restore purchases")) {
                Task { await subscriptions.restorePurchases() }
            }
            .padding(.horizontal, Theme.Spacing.screen)
        }
    }

    private var errorBinding: Binding<Bool> {
        Binding(
            get: { subscriptions.errorMessage != nil },
            set: { if !$0 { subscriptions.clearError() } }
        )
    }
}
