import SwiftUI

struct MainTabView: View {
    init() {
        let appearance = UITabBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.backgroundColor = UIColor.black
        appearance.shadowColor = UIColor(white: 1, alpha: 0.08)
        UITabBar.appearance().standardAppearance = appearance
        UITabBar.appearance().scrollEdgeAppearance = appearance
    }

    var body: some View {
        TabView {
            FeedView()
                .tabItem { Label("Feed", systemImage: "rectangle.stack") }

            AssistantView()
                .tabItem { Label("Assistant", systemImage: "sparkle") }

            OrganizationView()
                .tabItem { Label("Org", systemImage: "person.3") }

            IntegrationsView()
                .tabItem { Label("Tools", systemImage: "square.grid.2x2") }

            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
        .tint(Theme.Colors.textPrimary)
    }
}

#Preview {
    let state = AppState()
    MainTabView()
        .environmentObject(state)
        .environmentObject(state.preferences)
}
