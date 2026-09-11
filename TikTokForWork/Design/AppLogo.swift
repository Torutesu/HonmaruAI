import SwiftUI

struct AppLogo: View {
    var size: CGFloat = 56

    var body: some View {
        Image("AppMark")
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .accessibilityLabel("Honmaru AI")
    }
}

#Preview {
    ZStack {
        Theme.Colors.background.ignoresSafeArea()
        AppLogo(size: 72)
    }
}
