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

    var body: some View {
        HStack {
            tabButton(.home, systemImage: "house")
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

    private func tabButton(_ tab: AppTab, systemImage: String) -> some View {
        Button {
            selection = tab
        } label: {
            Image(systemName: selection == tab ? "\(systemImage).fill" : systemImage)
                .font(.system(size: 20, weight: .regular))
                .foregroundStyle(selection == tab ? Theme.Colors.textPrimary : Theme.Colors.textTertiary)
                .frame(width: 44, height: 44)
        }
        .accessibilityLabel(tab == .home ? Text("ホーム") : Text("あなた"))
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
        .accessibilityLabel(Text("作成"))
    }
}

#Preview {
    VStack {
        Spacer()
        AppTabBar(selection: .constant(.home), onCompose: {})
    }
    .background(Theme.Colors.background)
}
