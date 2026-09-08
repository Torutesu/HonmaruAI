import SwiftUI

/// The preserved source supplied with this card. Never invent email addresses,
/// calendar fields, or a live source document from a generated summary.
struct SourceSheet: View {
    let app: String
    let detail: String?
    let card: DecisionCard
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    private var original: String? { card.requestedBy?.quote ?? card.originalBody ?? card.sourceInstruction }
    private var senderName: String { card.requestedBy?.name ?? appState.workspaceMembers.first { $0.id == card.senderUserID }?.name ?? DisplayName.of(card.senderUserID, in: appState.organization) }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if appState.isGuest { Label("Sample data", systemImage: "square.stack.3d.up").font(.footnote).foregroundStyle(Theme.Colors.accent) }
                    if let detail, !detail.isEmpty { Text(detail).font(.title3.weight(.semibold)) }
                    HStack(spacing: 10) {
                        RequestAvatar(name: senderName, url: card.requestedBy?.avatarUrl, size: 36)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(senderName).font(.subheadline.weight(.semibold))
                            Text(card.createdAt, format: .dateTime.month(.abbreviated).day().hour().minute()).font(.caption).foregroundStyle(Theme.Colors.textSecondary)
                        }
                    }
                    Divider()
                    if let original, !original.isEmpty { Text(original).font(.body).lineSpacing(5) }
                    else {
                        Text("The original message was not included with this request.").font(.footnote).foregroundStyle(Theme.Colors.textSecondary)
                        Text("Summary").font(.subheadline.weight(.semibold))
                        Text(card.summary).font(.body).lineSpacing(5)
                    }
                    if !appState.isGuest, let source = card.requestedBy?.sourceUrl, let url = URL(string: source), ["https", "http"].contains(url.scheme ?? "") {
                        Link(destination: url) { Label("Open original source", systemImage: "arrow.up.right") }.font(.subheadline.weight(.medium))
                    }
                }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(Theme.Colors.background)
            .navigationTitle(appState.isGuest ? String(localized: "Sample source") : app)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }
    }
}
