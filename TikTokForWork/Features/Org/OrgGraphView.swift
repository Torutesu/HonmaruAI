import SwiftUI

struct OrgGraphView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var appState: AppState

    private var graph: OrganizationGraph { appState.organization }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                    section("People", items: graph.nodes.filter { $0.kind == .person })
                    section("Agents", items: graph.nodes.filter { $0.kind == .agent })
                    section("Teams", items: graph.nodes.filter { $0.kind == .team })
                    section("Projects", items: graph.nodes.filter { $0.kind == .project })

                    VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                        Text("Relationships")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.Colors.textTertiary)

                        ForEach(graph.edges) { edge in
                            Text(relationshipLabel(for: edge))
                                .font(.system(size: 13, design: .monospaced))
                                .foregroundStyle(Theme.Colors.textSecondary)
                        }
                    }
                }
                .padding(Theme.Spacing.screen)
            }
            .background(Theme.Colors.background)
            .navigationTitle("Organization")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
        }
        .presentationBackground(Theme.Colors.background)
    }

    private func section(_ title: LocalizedStringKey, items: [OrgNode]) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text(title)
                .font(.system(size: 12))
                .foregroundStyle(Theme.Colors.textTertiary)

            ForEach(items) { node in
                Text(node.label)
                    .font(.system(size: 15))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 10)
                    .padding(.horizontal, Theme.Spacing.md)
                    .background(Theme.Colors.surfaceRaised)
            }
        }
    }

    private func relationshipLabel(for edge: OrgEdge) -> String {
        let from = graph.nodes.first { $0.id == edge.fromID }?.label ?? edge.fromID
        let to = graph.nodes.first { $0.id == edge.toID }?.label ?? edge.toID
        return "\(from)  \(edge.kind.rawValue)  \(to)"
    }
}

#Preview {
    OrgGraphView()
        .environmentObject(AppState())
}
