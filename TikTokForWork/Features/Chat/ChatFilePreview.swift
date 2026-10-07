import SwiftUI
import AVKit
import QuickLook

/// Signed attachment URLs are data sources, never external navigation.
struct ChatFilePreview: View {
    let file: ChatFile
    let url: URL
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if file.type.hasPrefix("video/") || file.type.hasPrefix("audio/") {
                    ChatMediaPlayer(url: url)
                } else {
                    ChatDocumentPreview(file: file, url: url)
                }
            }
            .navigationTitle(file.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Close") { dismiss() } } }
        }
    }
}

/// AVPlayer streams ranges from R2; opening a video does not download it all.
private struct ChatMediaPlayer: View {
    @State private var item: AVPlayerItem
    @State private var player: AVPlayer
    @State private var failed = false

    init(url: URL) {
        let item = AVPlayerItem(url: url)
        _item = State(initialValue: item)
        _player = State(initialValue: AVPlayer(playerItem: item))
    }

    var body: some View {
        Group {
            if failed {
                ContentUnavailableView("Unable to preview this file", systemImage: "exclamationmark.triangle",
                    description: Text("The file may have expired or its format may not be supported. Reopen the conversation and try again."))
            } else {
                VideoPlayer(player: player)
                    .onReceive(item.publisher(for: \.status)) { status in failed = status == .failed }
            }
        }
        .onAppear { player.play() }
        .onDisappear { player.pause() }
    }
}

/// Quick Look reads a temporary local file, supporting image zoom and documents
/// without passing a signed storage URL to Safari. Downloads go to disk, not Data.
private struct ChatDocumentPreview: View {
    let file: ChatFile
    let url: URL
    @State private var localURL: URL?
    @State private var directory: URL?
    @State private var failed = false
    @State private var attempt = 0

    var body: some View {
        Group {
            if let localURL {
                if QLPreviewController.canPreview(localURL as NSURL) {
                    AttachmentQuickLook(url: localURL)
                } else {
                    VStack(spacing: 16) {
                        ContentUnavailableView("Unable to preview this file", systemImage: "doc")
                        ShareLink(item: localURL) { Label("Share", systemImage: "square.and.arrow.up") }
                    }
                }
            } else if failed {
                VStack(spacing: 16) {
                    ContentUnavailableView("Unable to preview this file", systemImage: "exclamationmark.triangle",
                        description: Text("The file may have expired or its format may not be supported. Reopen the conversation and try again."))
                    Button("Try again") { attempt += 1 }
                }
            } else {
                ProgressView()
            }
        }
        .task(id: attempt) { await load() }
        .onDisappear { removeTemporaryFile() }
    }

    @MainActor private func load() async {
        guard localURL == nil else { return }
        failed = false
        do {
            let (download, response) = try await URLSession.shared.download(from: url)
            defer { try? FileManager.default.removeItem(at: download) }
            try Task.checkCancellation()
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else { throw URLError(.badServerResponse) }
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent("honmaru-preview-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let name = (file.name as NSString).lastPathComponent
            let target = folder.appendingPathComponent(name.isEmpty || name == "." || name == ".." ? "attachment" : name)
            do { try FileManager.default.moveItem(at: download, to: target) }
            catch { try? FileManager.default.removeItem(at: folder); throw error }
            directory = folder
            localURL = target
        } catch {
            if !Task.isCancelled { failed = true }
        }
    }

    private func removeTemporaryFile() {
        if let directory { try? FileManager.default.removeItem(at: directory) }
        directory = nil
        localURL = nil
    }
}

private struct AttachmentQuickLook: UIViewControllerRepresentable {
    let url: URL
    func makeCoordinator() -> Coordinator { Coordinator(url: url) }
    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }
    func updateUIViewController(_ controller: QLPreviewController, context: Context) {
        if context.coordinator.url != url { context.coordinator.url = url; controller.reloadData() }
    }
    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        var url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
    }
}
