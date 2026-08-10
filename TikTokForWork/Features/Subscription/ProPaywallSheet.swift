import RevenueCat
import RevenueCatUI
import SwiftUI

/// The paywall the app presents everywhere.
///
/// Layout, copy, pricing, and A/B tests come from RevenueCat → Paywalls, so the offer can
/// change without an app release. If offerings can't be fetched (offline, or the dashboard
/// has no offering yet) we fall back to a native list built from the same packages, so the
/// user always has a way to subscribe or restore.
struct ProPaywallSheet: View {
    @EnvironmentObject private var subscriptions: SubscriptionService
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        content
            .task { await subscriptions.loadOfferings() }
    }

    @ViewBuilder
    private var content: some View {
        if let offering = subscriptions.currentOffering {
            PaywallView(offering: offering, displayCloseButton: true)
                .onPurchaseCompleted { customerInfo in
                    subscriptions.apply(customerInfo)
                    Haptics.success()
                    dismiss()
                }
                .onPurchaseFailure { error in
                    subscriptions.report(error)
                }
                .onRestoreCompleted { customerInfo in
                    subscriptions.apply(customerInfo)
                    // Only leave if the restore actually unlocked Pro — otherwise the user
                    // stays on the paywall with the plans still in front of them.
                    if customerInfo.entitlements[RevenueCatConfig.proEntitlementID]?.isActive == true {
                        Haptics.success()
                        dismiss()
                    }
                }
                .onRequestedDismissal {
                    dismiss()
                }
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
        .task {
            await subscriptions.loadOfferings(force: true)
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
                    Text(package.storeProduct.localizedDescription)
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
