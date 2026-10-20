import SwiftUI
import LinkPresentation
import CryptoKit

/// A link in a message, unfurled the way Messages does it: the system reads
/// the page on this phone — its title, picture, and for a YouTube video a
/// player — so nothing is sent through a server and no site turns the
/// reader away as a bot. Read once per link per launch.
@MainActor
final class ChatLinkMetadata {
    static let shared = ChatLinkMetadata()
    private var done: [URL: LPLinkMetadata] = [:]
    private var waiting: [URL: [(LPLinkMetadata?) -> Void]] = [:]

    func load(_ url: URL, _ finish: @escaping (LPLinkMetadata?) -> Void) {
        if let hit = done[url] { finish(hit); return }
        if waiting[url] != nil { waiting[url]?.append(finish); return }
        waiting[url] = [finish]
        let provider = LPMetadataProvider()
        provider.timeout = 8
        provider.startFetchingMetadata(for: url) { meta, _ in
            Task { @MainActor in
                if let meta { self.done[url] = meta }
                for f in self.waiting.removeValue(forKey: url) ?? [] { f(meta) }
            }
        }
    }

    /// The first link in some text worth a card, if any.
    static func firstLink(in text: String) -> URL? {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return nil }
        let range = NSRange(text.startIndex..., in: text)
        for match in detector.matches(in: text, range: range) {
            guard let url = match.url, let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else { continue }
            if url.path.contains("/channels/jam/audio/") { continue }
            return url
        }
        return nil
    }
}

private struct LinkView: UIViewRepresentable {
    let metadata: LPLinkMetadata
    func makeUIView(context: Context) -> LPLinkView { LPLinkView(metadata: metadata) }
    func updateUIView(_ view: LPLinkView, context: Context) { view.metadata = metadata }
}

struct ChatLinkPreview: View {
    let url: URL
    @State private var metadata: LPLinkMetadata?

    var body: some View {
        Group {
            if let metadata {
                LinkView(metadata: metadata)
                    .frame(maxWidth: 360, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .onAppear { ChatLinkMetadata.shared.load(url) { metadata = $0 } }
    }
}


/// The short hash of a login the Worker hands out as `loginHash` (and the
/// browser takes of a presence event): the first 16 hex digits of SHA-256.
enum ChatHash {
    static func short(_ login: String) -> String {
        SHA256.hash(data: Data(login.utf8)).map { String(format: "%02x", $0) }.joined().prefix(16).map { String($0) }.joined()
    }

    /// Whether the member whose `loginHash` this is has the app open now,
    /// by the logins the relay says are here.
    static func online(_ hash: String?, among logins: Set<String>) -> Bool {
        guard let hash, !hash.isEmpty else { return false }
        return logins.contains { short($0) == hash }
    }
}
