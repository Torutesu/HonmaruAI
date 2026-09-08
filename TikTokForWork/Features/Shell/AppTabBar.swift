import SwiftUI

enum AppTab: Hashable { case home, you }

/// Home and Profile are destinations; the center control opens a request.
struct AppTabBar: View {
    @Binding var selection: AppTab
    let onCompose: () -> Void
    var body: some View {
        HStack {
            Button { selection = .home } label: {
                Image(systemName: "house").font(.system(size: 25, weight: .medium))
                    .frame(width: 48, height: 48).foregroundStyle(selection == .home ? Theme.Colors.textPrimary : Theme.Colors.textTertiary)
            }.accessibilityLabel("Home").accessibilityAddTraits(selection == .home ? .isSelected : [])
            Spacer()
            Button(action: onCompose) {
                Image(systemName: "plus.circle").font(.system(size: 27, weight: .medium))
                    .foregroundStyle(Theme.Colors.ctaText).frame(width: 56, height: 56)
                    .background(Theme.Colors.ctaFill, in: Circle())
            }.accessibilityLabel("New request")
            Spacer()
            Button { selection = .you } label: {
                Image(systemName: "person").font(.system(size: 26, weight: .regular))
                    .frame(width: 48, height: 48).foregroundStyle(selection == .you ? Theme.Colors.textPrimary : Theme.Colors.textTertiary)
            }.accessibilityLabel("You").accessibilityAddTraits(selection == .you ? .isSelected : [])
        }
        .buttonStyle(PressFeedbackStyle())
        .padding(.horizontal, 54).padding(.top, 16).padding(.bottom, 10)
        .background(Theme.Colors.surface.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) { Divider() }
    }
}
