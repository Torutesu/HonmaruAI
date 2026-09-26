import SwiftUI

/// The agents in a channel or a group: the ones added, which anyone here
/// may call with @ and its name, and yours to add — your own personal
/// agents included, which become callable here once added.
struct ChatChannelAgentsSheet: View {
    @ObservedObject var store: ChatStore
    let view: String
    let title: String
    @Environment(\.dismiss) private var dismiss
    @State private var loaded: ChatService.ChannelAgents?
    @State private var loading = true
    @State private var problem: String?
    @State private var busy: String?

    var body: some View {
        NavigationStack {
            List {
                if let problem {
                    Text(problem).font(.footnote).foregroundStyle(.red)
                }
                Section {
                    if loading && loaded == nil {
                        ProgressView()
                    } else if (loaded?.placed ?? []).isEmpty {
                        Text("No agents here yet.").foregroundStyle(Theme.Colors.textSecondary)
                    }
                    ForEach(loaded?.placed ?? []) { a in
                        HStack(spacing: 12) {
                            Text(verbatim: a.glyph).font(.title3).frame(width: 32, height: 32)
                                .background(Circle().fill(Theme.Colors.textSecondary.opacity(0.12)))
                            VStack(alignment: .leading, spacing: 2) {
                                Text(verbatim: "\(a.name) @\(a.handle ?? "")").font(.subheadline.weight(.semibold)).lineLimit(1)
                                if let d = a.description, !d.isEmpty {
                                    Text(verbatim: d).font(.caption).foregroundStyle(Theme.Colors.textSecondary).lineLimit(2)
                                } else if let owner = a.owner {
                                    Text("Added by \(owner)").font(.caption).foregroundStyle(Theme.Colors.textSecondary)
                                }
                            }
                            Spacer(minLength: 0)
                            if a.canRemove == true, let id = a.id {
                                Button(role: .destructive) { Task { await place(id, add: false) } } label: {
                                    if busy == id { ProgressView() } else { Image(systemName: "minus.circle") }
                                }
                                .buttonStyle(.borderless)
                                .disabled(busy != nil)
                                .accessibilityLabel(Text("Remove \(a.name) from here"))
                            }
                        }
                    }
                } header: {
                    Text("In this conversation")
                } footer: {
                    Text("Anyone here can call the agent you add, with @ and its name.")
                }
                if let addable = loaded?.addableAgents, !addable.isEmpty {
                    Section("Add an agent") {
                        ForEach(addable) { a in
                            Button { Task { await place(a.id, add: true) } } label: {
                                HStack(spacing: 12) {
                                    Text(verbatim: a.glyph).font(.title3).frame(width: 32, height: 32)
                                        .background(Circle().fill(Theme.Colors.textSecondary.opacity(0.12)))
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(verbatim: "\(a.name) @\(a.handle)").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.Colors.textPrimary).lineLimit(1)
                                        Text(a.scope == "personal" ? LocalizedStringKey("Your own agent") : LocalizedStringKey("Team agent"))
                                            .font(.caption).foregroundStyle(Theme.Colors.textSecondary)
                                    }
                                    Spacer(minLength: 0)
                                    if busy == a.id { ProgressView() } else { Image(systemName: "plus.circle.fill").foregroundStyle(Theme.Colors.accent) }
                                }
                            }
                            .disabled(busy != nil)
                        }
                    }
                }
            }
            .navigationTitle(Text("Agents"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .task { await load() }
            .refreshable { await load() }
        }
    }

    private func load() async {
        loading = true
        if let got = await store.channelAgents(view) {
            loaded = got
            problem = nil
        } else if loaded == nil {
            problem = String(localized: "The details did not load. Try again.")
        }
        loading = false
    }

    private func place(_ id: String, add: Bool) async {
        busy = id
        problem = await store.placeAgent(id, in: view, add: add)
        await load()
        busy = nil
    }
}
