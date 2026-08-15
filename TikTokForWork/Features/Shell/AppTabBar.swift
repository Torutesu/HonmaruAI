import SwiftUI

/// The three destinations in the bottom chrome. Compose is not a tab — it opens
/// the feed's compose flow over whatever is on screen — but it lives in the same
/// bar, so it is modelled here to keep the layout in one place.
enum AppTab: Hashable {
    case home
    case you
}

/// White translucent bar with a hairline top border, per the design system's
/// "elevation is borders, not shadows" rule.
struct AppTabBar: View {
    @Binding var selection: AppTab
    let onCompose: () -> Void
    /// The way in without a camera, on a long press. Nil leaves the ＋ doing
    /// one thing.
    var onComposeText: (() -> Void)?
    /// Decisions waiting on you. The count already existed and was already on
    /// the app icon; not having it on the tab meant leaving Home was the only
    /// way to stop knowing.
    var pendingCount: Int = 0

    var body: some View {
        HStack {
            tabButton(.home, systemImage: "house", badge: pendingCount)
            Spacer()
            composeButton
            Spacer()
            tabButton(.you, systemImage: "person")
        }
        .padding(.horizontal, 44)
        .padding(.top, Theme.Spacing.sm)
        .padding(.bottom, Theme.Spacing.xs)
        .background(alignment: .top) {
            ZStack(alignment: .top) {
                Rectangle()
                    .fill(.regularMaterial)
                    .ignoresSafeArea(edges: .bottom)
                Rectangle()
                    .fill(Theme.Colors.border)
                    .frame(height: 1)
            }
        }
    }

    private func tabButton(_ tab: AppTab, systemImage: String, badge: Int = 0) -> some View {
        Button {
            selection = tab
        } label: {
            Image(systemName: selection == tab ? "\(systemImage).fill" : systemImage)
                .font(.system(size: 20, weight: .regular))
                .foregroundStyle(selection == tab ? Theme.Colors.textPrimary : Theme.Colors.textTertiary)
                .frame(width: 44, height: 44)
                .overlay(alignment: .topTrailing) {
                    if badge > 0 { badgeView(badge) }
                }
        }
        .accessibilityLabel(tab == .home ? Text("Home") : Text("You"))
        .accessibilityValue(badge > 0 ? Text("\(badge) waiting") : Text(""))
    }

    /// Violet, because the design system reserves it for badges and AI markers.
    /// Capped at 99+: past that the number has stopped being information.
    private func badgeView(_ count: Int) -> some View {
        Text(count > 99 ? "99+" : "\(count)")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, count > 9 ? 5 : 0)
            .frame(minWidth: 16, minHeight: 16)
            .background(Theme.Colors.accent)
            .clipShape(Capsule())
            .offset(x: -2, y: 4)
            .accessibilityHidden(true)
    }

    private var composeButton: some View {
        Button(action: onCompose) {
            ConicRingCircle(diameter: 46)
                .overlay {
                    Image(systemName: "plus")
                        .font(.system(size: 18, weight: .medium))
                        .foregroundStyle(Theme.Colors.textPrimary)
                }
        }
        .simultaneousGesture(
            LongPressGesture(minimumDuration: 0.4).onEnded { _ in onComposeText?() }
        )
        .accessibilityLabel(Text("Create"))
        .accessibilityAction(named: Text("Type instead")) { onComposeText?() }
    }
}

#Preview {
    VStack {
        Spacer()
        AppTabBar(selection: .constant(.home), onCompose: {})
    }
    .background(Theme.Colors.background)
}
