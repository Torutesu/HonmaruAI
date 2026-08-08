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

    /// Resolves what a card stored back into something playable.
    ///
    /// A `file:` URL is rewritten against the current container, because the app's
    /// sandbox path changes between installs and an absolute path saved earlier
    /// stops resolving after an update.
    static func playableURL(from stored: String) -> URL? {
        guard let url = URL(string: stored) else { return nil }
        guard url.isFileURL else { return url }

        let relocated = directory.appendingPathComponent(url.lastPathComponent)
        return FileManager.default.fileExists(atPath: relocated.path) ? relocated : nil
    }
}
