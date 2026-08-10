import RevenueCat
import RevenueCatUI
import SwiftUI

/// Account screen for everything subscription related: current entitlement, plan details,
/// and the entry points into the RevenueCat Customer Center and paywall.
struct SubscriptionView: View {
    @EnvironmentObject private var subscriptions: SubscriptionService
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    // Local presentation state: `SubscriptionService.showPaywall` is the app-wide gate
    // owned by the feed, and two views must never drive the same sheet flag.
    @State private var showCustomerCenter = false
    @State private var showPaywall = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    statusCard

                    if subscriptions.isPro {
                        proActions
                    } else {
                        freeActions
                    }

                    footer
                }
                .padding(Theme.Spacing.screen)
            }
            .appBackground()
            .navigationTitle("Subscription")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
        }
        .preferredColorScheme(.dark)
        .task { await subscriptions.refresh() }
        // The Customer Center is a full self-service flow — cancel, change plan, request a
        // refund, run a cancellation survey — all configured in the RevenueCat dashboard.
        .sheet(isPresented: $showCustomerCenter) {
            CustomerCenterView()
                .onCustomerCenterRestoreCompleted { customerInfo in
                    subscriptions.apply(customerInfo)
                }
                .onCustomerCenterRefundRequestCompleted { _, _ in
                    Task { await subscriptions.refreshCustomerInfo() }
                }
        }
        .sheet(isPresented: $showPaywall) {
            ProPaywallSheet()
        }
        .alert("Subscription", isPresented: errorBinding) {
            Button("OK", role: .cancel) { subscriptions.clearError() }
        } message: {
            Text(subscriptions.errorMessage ?? "")
        }
    }

    // MARK: - Status

    private var statusCard: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            HStack(spacing: Theme.Spacing.sm) {
                Circle()
                    .fill(subscriptions.isPro ? Theme.Colors.approve : Theme.Colors.textTertiary)
                    .frame(width: 6, height: 6)
                Text(subscriptions.isPro ? String(localized: "honmaruai Pro") : String(localized: "Free plan"))
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(Theme.Colors.textPrimary)
                Spacer()
                if let summary = subscriptions.summary {
                    if summary.isTrial { LabelChip(text: String(localized: "Trial")) }
                    if summary.isSandbox { LabelChip(text: String(localized: "Sandbox")) }
                }
            }

            if let summary = subscriptions.summary {
                detailRow(String(localized: "Plan"), summary.planName)
                detailRow(String(localized: "Status"), summary.renewalDescription)
                detailRow(String(localized: "Billed via"), summary.storeDescription)

                if summary.hasBillingIssue {
                    noticeRow(String(localized: "Update your payment method to keep Pro active."), tint: Theme.Colors.reject)
                } else if summary.cancellationDetected, !summary.willRenew {
                    noticeRow(
                        String(localized: "Auto-renew is off. Pro stays active until the end of the period."),
                        tint: Theme.Colors.textSecondary
                    )
                }
            } else {
                // The daily routing count is metered server-side and the Worker does not
                // expose remaining quota, so we state the policy rather than a live count —
                // a client-side counter would drift from the server's number.
                Text("Free plan: 3 AI-routed decisions a day, then keyword routing. Pro: unlimited AI routing and the org graph.")
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(Theme.Spacing.md)
        .background(Theme.Colors.surfaceRaised)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
    }

    // MARK: - Actions

    private var proActions: some View {
        VStack(spacing: Theme.Spacing.sm) {
            PrimaryButton(title: String(localized: "Manage subscription")) {
                showCustomerCenter = true
            }

            if let summary = subscriptions.summary, !summary.isAppleManaged, let url = summary.managementURL {
                SecondaryAction(title: String(localized: "Open billing portal")) {
                    openURL(url)
                }
            }

            SecondaryAction(title: subscriptions.isRestoring ? String(localized: "Restoring…") : String(localized: "Restore purchases")) {
                Task { await subscriptions.restorePurchases() }
            }
        }
    }

    private var freeActions: some View {
        VStack(spacing: Theme.Spacing.sm) {
            PrimaryButton(title: String(localized: "Upgrade to Pro")) {
                showPaywall = true
            }

            SecondaryAction(title: subscriptions.isRestoring ? String(localized: "Restoring…") : String(localized: "Restore purchases")) {
                Task { await subscriptions.restorePurchases() }
            }

            // Customer Center also covers "I already paid" support paths for people whose
            // purchase sits on another account, so keep it reachable while free.
            SecondaryAction(title: String(localized: "Get help with a purchase")) {
                showCustomerCenter = true
            }
        }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            if let appUserID = subscriptions.appUserID {
                Text(verbatim: "\(String(localized: "Account")) \(appUserID)")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(Theme.Colors.textTertiary)
                    .textSelection(.enabled)
            }
            Text("Subscriptions renew automatically until cancelled.")
                .font(Theme.TypeScale.micro)
                .foregroundStyle(Theme.Colors.textTertiary)
        }
    }

    private func detailRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top, spacing: Theme.Spacing.md) {
            Text(label)
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textTertiary)
                .frame(width: 96, alignment: .leading)
            Text(value)
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func noticeRow(_ text: String, tint: Color) -> some View {
        Text(text)
            .font(Theme.TypeScale.caption)
            .foregroundStyle(tint)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var errorBinding: Binding<Bool> {
        Binding(
            get: { subscriptions.errorMessage != nil },
            set: { if !$0 { subscriptions.clearError() } }
        )
    }
}

// MARK: - Reusable entry points

extension View {
    /// Presents the RevenueCat paywall as a sheet.
    func proPaywall(isPresented: Binding<Bool>) -> some View {
        sheet(isPresented: isPresented) {
            ProPaywallSheet()
        }
    }
}

/// Small "PRO" marker for chrome that should reflect entitlement state.
struct ProBadge: View {
    var body: some View {
        Text("PRO")
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(Theme.Colors.background)
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(Theme.Colors.approve)
            .clipShape(Capsule())
    }
}
