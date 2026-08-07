import SwiftUI

struct AssistantContextView: View {
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var preferences: AppPreferences

    private let graph = DemoData.organization

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                section("You") {
                    if let user = appState.currentUser {
                        infoRow("Name", user.name)
                        infoRow("Role", user.role)
                        if let manager = graph.manager(of: user.id) {
                            infoRow("Reports to", manager.label)
                        }
                        let projects = graph.approvalProjects(for: user.id)
                        if !projects.isEmpty {
                            infoRow("Can approve", projects.map(\.label).joined(separator: " · "))
                        }
                    }
                }

                section("Sources") {
                    infoRow("Repository", appState.githubService.connection?.repository ?? "Not linked")
                    infoRow("Tools", toolsSummary)
                    infoRow("Relay", appState.aiService.isConfigured ? "Connected" : "Offline")
                }

                section("Behavior") {
                    infoRow("Tone", preferences.tone.label)
                    infoRow("Autonomy", preferences.autonomy.label)
                    infoRow("Language", preferences.language.label)
                }

                Text("Your AI uses this context to decide who receives each instruction and how to phrase the decision card.")
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textTertiary)
                    .lineSpacing(4)
            }
            .padding(Theme.Spacing.screen)
        }
        .background(Theme.Colors.background)
        .navigationTitle("What your AI knows")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var toolsSummary: String {
        var names: [String] = []
        if appState.githubService.hasToken { names.append("GitHub") }
        names += WorkTool.allCases
            .filter { $0 != .github && preferences.connectedTools.contains($0) }
            .map(\.label)
        return names.isEmpty ? "None connected" : names.joined(separator: " · ")
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text(title)
                .font(Theme.TypeScale.micro)
                .foregroundStyle(Theme.Colors.textTertiary)
                .textCase(.uppercase)
                .tracking(0.8)
            VStack(spacing: 1) {
                content()
            }
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
        }
    }

    private func infoRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top) {
            Text(label)
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textTertiary)
                .frame(width: 96, alignment: .leading)
            Text(value)
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(Theme.Spacing.md)
        .background(Theme.Colors.surface)
    }
}

struct AgentActivityView: View {
    @EnvironmentObject private var appState: AppState
    @State private var events: [ActivityEvent] = []

    struct ActivityEvent: Identifiable {
        let id: String
        let icon: String
        let text: String
        let detail: String
        let date: Date
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                if events.isEmpty {
                    VStack(spacing: Theme.Spacing.sm) {
                        Text("No agent activity yet")
                            .font(.system(size: 17, weight: .medium))
                            .foregroundStyle(Theme.Colors.textPrimary)
                        Text("Routing, delivery, and sync events show up here")
                            .font(Theme.TypeScale.caption)
                            .foregroundStyle(Theme.Colors.textTertiary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, Theme.Spacing.xxl)
                } else {
                    ForEach(events) { event in
                        HStack(alignment: .top, spacing: Theme.Spacing.md) {
                            Image(systemName: event.icon)
                                .font(.system(size: 12))
                                .foregroundStyle(Theme.Colors.accent)
                                .frame(width: 20)
                                .padding(.top, 2)

                            VStack(alignment: .leading, spacing: 2) {
                                Text(event.text)
                                    .font(Theme.TypeScale.body)
                                    .foregroundStyle(Theme.Colors.textPrimary)
                                    .fixedSize(horizontal: false, vertical: true)
                                Text(event.detail)
                                    .font(Theme.TypeScale.label)
                                    .foregroundStyle(Theme.Colors.textTertiary)
                            }

                            Spacer()

                            Text(DateFormatting.relative(event.date))
                                .font(Theme.TypeScale.micro)
                                .foregroundStyle(Theme.Colors.textTertiary)
                        }
                        .padding(Theme.Spacing.md)
                        .background(Theme.Colors.surface)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
                    }
                }
            }
            .padding(Theme.Spacing.screen)
        }
        .background(Theme.Colors.background)
        .navigationTitle("Agent activity")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear(perform: refresh)
    }

    private func refresh() {
        guard let userID = appState.currentUser?.id else { return }
        let myName = DemoData.userName(for: userID)

        let sent = appState.cardService.cards(sentBy: userID).map { card in
            ActivityEvent(
                id: "sent-\(card.id)",
                icon: "arrow.up.right",
                text: "Your AI routed \"\(card.title)\" to \(DemoData.agentName(for: card.recipientUserID))",
                detail: card.routingReason ?? "Routed via org graph",
                date: card.createdAt
            )
        }

        let received = appState.cardService.cards(for: userID).map { card in
            ActivityEvent(
                id: "recv-\(card.id)",
                icon: "arrow.down.left",
                text: "\(DemoData.agentName(for: card.senderUserID)) delivered \"\(card.title)\" to \(myName)'s feed",
                detail: card.status == .pending ? "Waiting for your decision" : card.status.label,
                date: card.createdAt
            )
        }

        events = (sent + received).sorted { $0.date > $1.date }
    }
}

#Preview {
    let state = AppState()
    NavigationStack {
        AssistantContextView()
            .environmentObject(state)
            .environmentObject(state.preferences)
    }
}
