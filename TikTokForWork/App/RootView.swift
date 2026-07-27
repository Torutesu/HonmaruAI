import SwiftUI

struct RootView: View {
    @EnvironmentObject private var appState: AppState

    var body: some View {
        Group {
            if appState.isAuthenticated, appState.currentUser != nil {
                FeedView()
            } else {
                AuthView()
            }
        }
        .appBackground()
        .preferredColorScheme(.dark)
        .animation(.easeOut(duration: 0.2), value: appState.isAuthenticated)
    }
}

#Preview {
    RootView()
        .environmentObject(AppState())
}
