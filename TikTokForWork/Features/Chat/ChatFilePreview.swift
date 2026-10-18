import SwiftUI
import AVKit
import QuickLook

/// Signed attachment URLs are data sources, never external navigation.
struct ChatFilePreview: View {
    let file: ChatFile
    let url: URL
    /// Asks for a new address for the file now, for a player whose address
    /// stopped opening: nil when there is none newer.
    var onExpired: (@MainActor () async -> URL?)? = nil
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if file.type.hasPrefix("video/") || file.type.hasPrefix("audio/") {
                    ChatMediaPlayer(url: url, onExpired: onExpired)
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
///
/// It goes on asking for ranges at the address its item was made with, and
/// that address is signed for minutes. A renewed one, handed down while the
/// preview is open, replaces the item — at the same place, playing if it
/// was — and so does a new one asked for when the address it has stops
/// opening. Only when there is none newer is the failure shown, with Try
/// again; an address the reader may no longer have is not asked for over
/// and over.
private struct ChatMediaPlayer: View {
    let url: URL
    let onExpired: (@MainActor () async -> URL?)?
    @State private var item: AVPlayerItem
    @State private var player: AVPlayer
    /// The address `item` plays from.
    @State private var source: URL
    /// Where to go on from once a replaced item is ready.
    @State private var resumeAt: CMTime?
    @State private var failed = false

    init(url: URL, onExpired: (@MainActor () async -> URL?)? = nil) {
        self.url = url
        self.onExpired = onExpired
        let item = AVPlayerItem(url: url)
        _item = State(initialValue: item)
        _player = State(initialValue: AVPlayer(playerItem: item))
        _source = State(initialValue: url)
    }

    var body: some View {
        Group {
            if failed {
                VStack(spacing: 16) {
                    ContentUnavailableView("Unable to preview this file", systemImage: "exclamationmark.triangle",
                        description: Text("The file may have expired or its format may not be supported. Reopen the conversation and try again."))
                    Button("Try again") { Task { await retry() } }
                }
            } else {
                VideoPlayer(player: player)
            }
        }
        .onAppear { player.play() }
        .onDisappear { player.pause() }
        .onChange(of: url) { _, next in adopt(next) }
        // Watched per item: a replaced one is watched in its place.
        .task(id: ObjectIdentifier(item)) {
            for await status in item.publisher(for: \.status).values {
                await settle(status)
            }
        }
    }

    @MainActor private func settle(_ status: AVPlayerItem.Status) async {
        switch status {
        case .readyToPlay:
            failed = false
            if let at = resumeAt {
                resumeAt = nil
                _ = await player.seek(to: at, toleranceBefore: .zero, toleranceAfter: .zero)
            }
        case .failed:
            await recover()
        default:
            break
        }
    }

    /// Its address stopped opening: the newer one already handed down, or
    /// one asked for now; failed only when there is none.
    @MainActor private func recover() async {
        if url != source { adopt(url, play: true); return }
        if let next = await onExpired?(), next != source { adopt(next, play: true); return }
        failed = true
    }

    /// Try again: a new address if there is one, else the same one afresh.
    @MainActor private func retry() async {
        if let next = await onExpired?(), next != source { adopt(next, play: true) } else { adopt(url, force: true, play: true) }
    }

    /// Plays from `next` instead, from where it had got to, and playing if
    /// it was — or, after a failure, playing as it does when it is opened.
    @MainActor private func adopt(_ next: URL, force: Bool = false, play: Bool? = nil) {
        guard force || next != source else { return }
        let at = player.currentTime()
        let playing = play ?? (player.rate != 0)
        let replacement = AVPlayerItem(url: next)
        resumeAt = at.isNumeric && at.seconds > 0 ? at : nil
        source = next
        item = replacement
        failed = false
        player.replaceCurrentItem(with: replacement)
        if playing { player.play() }
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
