import AVFoundation
import Foundation

/// Keeps recorded clips on the phone.
///
/// The relay is a nice-to-have for video: it is what lets someone else watch.
/// But a decision you just recorded has to play back whether or not the relay
/// is reachable, so the local copy is the source of truth and the upload is an
/// upgrade applied on top of it when it succeeds.
enum MediaStore {
    private static var directory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Captures", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base
    }

    /// Moves a freshly recorded clip out of the temporary directory, which the
    /// system is free to empty, and returns the URL to keep.
    static func keep(_ file: URL) -> URL? {
        let destination = directory.appendingPathComponent(file.lastPathComponent)
        do {
            if FileManager.default.fileExists(atPath: destination.path) {
                try FileManager.default.removeItem(at: destination)
            }
            try FileManager.default.moveItem(at: file, to: destination)
            return destination
        } catch {
            return nil
        }
    }

    /// Re-encodes a capture at 960x540 before upload. Storage is what R2 bills
    /// for, and a raw phone capture is ~20x larger than it needs to be for a
    /// talking-head clip. Returns the original URL if export is unavailable.
    static func compress(_ source: URL) async -> URL {
        let asset = AVURLAsset(url: source)
        guard let export = AVAssetExportSession(asset: asset, presetName: AVAssetExportPreset960x540) else {
            return source
        }
        let target = source.deletingPathExtension().appendingPathExtension("small.mp4")
        try? FileManager.default.removeItem(at: target)
        export.shouldOptimizeForNetworkUse = true

        // `export(to:as:)` arrived in iOS 18 and this call was unguarded, so
        // the app did not build against an SDK new enough to see it — which is
        // every current Xcode. The deployment target is 17: an iPhone on iOS 17
        // would have found no such method at runtime.
        if #available(iOS 18, *) {
            do {
                try await export.export(to: target, as: .mp4)
                return target
            } catch {
                return source
            }
        }

        // iOS 17 keeps the older path. A continuation rather than the bridged
        // async spelling, because that bridge is exactly the kind of thing that
        // changes between SDKs — and this branch exists precisely to be immune
        // to that.
        export.outputURL = target
        export.outputFileType = .mp4
        await withCheckedContinuation { continuation in
            export.exportAsynchronously { continuation.resume() }
        }
        // Status, not the absence of an error: a cancelled export reports
        // `.cancelled` with nothing thrown, and the original file is the right
        // answer for that as much as for a failure.
        return export.status == .completed ? target : source
    }

    /// Resolves what a card stored back into something playable.
    ///
    /// A `file:` URL is rewritten against the current container, because the app's
    /// sandbox path changes between installs and an absolute path saved earlier
    /// stops resolving after an update.
    ///
    /// A remote clip needs the session token: `/media/:id` used to serve a
    /// recording to anyone who had the URL, and now does not. AVPlayer streams
    /// the URL itself and there is no supported way to put a header on the
    /// requests it makes, so the token rides in the query string — attached
    /// here, at play time, and never stored on the card, which outlives it.
    static func playableURL(from stored: String) -> URL? {
        guard let url = URL(string: stored) else { return nil }
        guard url.isFileURL else { return authorized(url) }

        let relocated = directory.appendingPathComponent(url.lastPathComponent)
        return FileManager.default.fileExists(atPath: relocated.path) ? relocated : nil
    }

    /// Only for this app's own media, and only when signed in. Appending a
    /// session token to somebody else's host would hand them the session.
    static func authorized(_ url: URL) -> URL {
        guard let token = SessionStore.sessionToken, !token.isEmpty,
              let backend = BackendURL.httpBase(from: AppConfig.relayURL),
              url.host == backend.host,
              url.path.hasPrefix("/media/"),
              var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { return url }
        var query = parts.queryItems ?? []
        query.removeAll { $0.name == "t" }
        query.append(URLQueryItem(name: "t", value: token))
        parts.queryItems = query
        return parts.url ?? url
    }
}
