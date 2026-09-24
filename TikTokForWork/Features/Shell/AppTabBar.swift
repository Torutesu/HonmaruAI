import SwiftUI

enum AppTab: Hashable { case home, chat, you }

/// Home, Chat and Profile are destinations; the round control opens a
/// request. The bar floats in glass, and on iOS 26 the two shapes melt
/// together as the system's own controls do.
struct AppTabBar: View {
    @Binding var selection: AppTab
    var chatBadge = 0
    let onCompose: () -> Void
    @Namespace private var pill

    var body: some View {
        GlassGroup(spacing: 14) {
            HStack(spacing: 12) {
                HStack(spacing: 4) {
                    item(.home, icon: "house", label: "Home")
                    item(.chat, icon: "bubble.left.and.bubble.right", label: "Chat", badge: chatBadge)
                    item(.you, icon: "person", label: "You")
                }
                .padding(5)
                .glassCapsule(interactive: true)
                Button(action: onCompose) {
                    Image(systemName: "plus").font(.system(size: 22, weight: .semibold))
                        .foregroundStyle(Theme.Colors.ctaText).frame(width: 58, height: 58)
                        .glassCircle(tint: Theme.Colors.ctaFill)
                }.accessibilityLabel("New request")
            }
        }
        .buttonStyle(PressFeedbackStyle())
        .padding(.horizontal, 20).padding(.top, 6).padding(.bottom, 6)
        .animation(.spring(response: 0.32, dampingFraction: 0.82), value: selection)
    }

    private func item(_ tab: AppTab, icon: String, label: LocalizedStringKey, badge: Int = 0) -> some View {
        let on = selection == tab
        return Button { selection = tab; Haptics.light() } label: {
            VStack(spacing: 2) {
                Image(systemName: on ? "\(icon).fill" : icon).font(.system(size: 19, weight: .medium))
                Text(label).font(.system(size: 10, weight: .semibold))
            }
            .foregroundStyle(on ? Theme.Colors.textPrimary : Theme.Colors.textTertiary)
            .frame(maxWidth: .infinity, minHeight: 48)
            .background {
                if on { Capsule().fill(Theme.Colors.textPrimary.opacity(0.08)).matchedGeometryEffect(id: "pill", in: pill) }
            }
            .overlay(alignment: .topTrailing) {
                if badge > 0 {
                    Text(badge > 99 ? "99+" : "\(badge)").font(.system(size: 10, weight: .bold)).foregroundStyle(.white)
                        .padding(.horizontal, 5).padding(.vertical, 1).background(Theme.Colors.reject, in: Capsule())
                        .offset(x: -14, y: 2)
                }
            }
            .contentShape(Capsule())
        }
        .accessibilityLabel(label)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}
