import SwiftUI

struct OrganizationView: View {
    enum Section: String, CaseIterable, Identifiable {
        case teams = "Teams"
        case people = "People"
        case agents = "AI Agents"
        case graph = "Graph"

        var id: String { rawValue }
    }

    @State private var section: Section = .teams

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("Section", selection: $section) {
                    ForEach(Section.allCases) { section in
                        Text(section.rawValue).tag(section)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, Theme.Spacing.screen)
                .padding(.vertical, Theme.Spacing.sm)

                Group {
                    switch section {
                    case .teams: TeamsSection()
                    case .people: PeopleSection()
                    case .agents: AgentsSection()
                    case .graph: OrgGraphView()
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .background(Theme.Colors.background)
            .navigationTitle("Organization")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

private struct TeamsSection: View {
    private let graph = DemoData.organization

    /// Which tools each team's AI acts through in the demo org.
    private let teamTools: [String: [WorkTool]] = [
        "team-product": [.slack, .notion],
        "team-engineering": [.github],
        "team-design": [.gmail, .calendar],
        "team-core": [.slack, .github]
    ]

    var body: some View {
        ScrollView {
            VStack(spacing: Theme.Spacing.sm) {
                ForEach(graph.nodes.filter { $0.kind == .team }) { team in
                    VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                        HStack {
                            Text(team.label)
                                .font(.system(size: 15, weight: .medium))
                                .foregroundStyle(Theme.Colors.textPrimary)
                            Spacer()
                            Text("\(members(of: team.id).count) member\(members(of: team.id).count == 1 ? "" : "s")")
                                .font(Theme.TypeScale.label)
                                .foregroundStyle(Theme.Colors.textTertiary)
                        }

                        Text(members(of: team.id).map(\.label).joined(separator: " · "))
                            .font(Theme.TypeScale.label)
                            .foregroundStyle(Theme.Colors.textSecondary)

                        HStack(spacing: Theme.Spacing.sm) {
                            HStack(spacing: 4) {
                                Image(systemName: "sparkle")
                                    .font(.system(size: 9))
                                Text("\(shortName(team.label)) AI")
                            }
                            .font(Theme.TypeScale.micro)
                            .foregroundStyle(Theme.Colors.accent)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(Theme.Colors.surfaceRaised)
                            .clipShape(Capsule())

                            ForEach(teamTools[team.id] ?? []) { tool in
                                LabelChip(text: tool.label)
                            }
                        }
                    }
                    .padding(Theme.Spacing.md)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.Colors.surface)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
                }
            }
            .padding(Theme.Spacing.screen)
        }
    }

    private func members(of teamID: String) -> [OrgNode] {
        let memberIDs = graph.edges
            .filter { $0.toID == teamID && $0.kind == .memberOf }
            .map(\.fromID)
        return graph.nodes.filter { memberIDs.contains($0.id) }
    }

    private func shortName(_ label: String) -> String {
        label.replacingOccurrences(of: " Team", with: "")
    }
}

private struct PeopleSection: View {
    private let graph = DemoData.organization

    var body: some View {
        ScrollView {
            VStack(spacing: Theme.Spacing.sm) {
                ForEach(DemoUser.allCases) { demo in
                    let user = demo.user
                    HStack(spacing: Theme.Spacing.md) {
                        Text(String(user.name.prefix(1)))
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(Theme.Colors.textPrimary)
                            .frame(width: 36, height: 36)
                            .background(Theme.Colors.surfaceRaised)
                            .clipShape(Circle())

                        VStack(alignment: .leading, spacing: 2) {
                            Text(user.name)
                                .font(.system(size: 15, weight: .medium))
                                .foregroundStyle(Theme.Colors.textPrimary)
                            Text(user.role)
                                .font(Theme.TypeScale.label)
                                .foregroundStyle(Theme.Colors.textTertiary)
                            if let manager = graph.manager(of: user.id) {
                                Text("Reports to \(manager.label)")
                                    .font(Theme.TypeScale.micro)
                                    .foregroundStyle(Theme.Colors.textTertiary)
                            }
                        }

                        Spacer()

                        HStack(spacing: 4) {
                            Image(systemName: "sparkle")
                                .font(.system(size: 9))
                            Text("\(user.name)'s AI")
                        }
                        .font(Theme.TypeScale.micro)
                        .foregroundStyle(Theme.Colors.accent)
                    }
                    .padding(Theme.Spacing.md)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.Colors.surface)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
                }
            }
            .padding(Theme.Spacing.screen)
        }
    }
}

private struct AgentsSection: View {
    private let graph = DemoData.organization

    var body: some View {
        ScrollView {
            VStack(spacing: Theme.Spacing.sm) {
                ForEach(DemoUser.allCases) { demo in
                    let user = demo.user
                    VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                        HStack(spacing: Theme.Spacing.sm) {
                            Image(systemName: "sparkle")
                                .font(.system(size: 12))
                                .foregroundStyle(Theme.Colors.accent)
                            Text("\(user.name)'s AI")
                                .font(.system(size: 15, weight: .medium))
                                .foregroundStyle(Theme.Colors.textPrimary)
                            Spacer()
                            Text("Active")
                                .font(Theme.TypeScale.micro)
                                .foregroundStyle(Theme.Colors.approve)
                        }

                        Text("Acts for \(user.name) · \(user.role)")
                            .font(Theme.TypeScale.label)
                            .foregroundStyle(Theme.Colors.textSecondary)

                        Text(scopeLine(for: user))
                            .font(Theme.TypeScale.micro)
                            .foregroundStyle(Theme.Colors.textTertiary)
                    }
                    .padding(Theme.Spacing.md)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.Colors.surface)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
                }
            }
            .padding(Theme.Spacing.screen)
        }
    }

    private func scopeLine(for user: User) -> String {
        let projects = graph.approvalProjects(for: user.id)
        if projects.isEmpty {
            return "Routes decisions · drafts cards · syncs to GitHub"
        }
        return "Approval authority: \(projects.map(\.label).joined(separator: " · "))"
    }
}

#Preview {
    OrganizationView()
        .environmentObject(AppState())
}
