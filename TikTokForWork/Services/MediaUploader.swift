import Foundation

/// Ships a recorded clip to the relay and returns the URL a card can carry.
enum MediaUploader {
    struct Response: Decodable {
        let id: String
        let url: String
    }

    /// Uploads the file and leaves it alone. The clip is kept by `MediaStore`
    /// so playback works with the relay unreachable; deleting it here would make
    /// a failed upload cost you the recording.
    static func upload(_ file: URL, to backendBaseURL: URL) async throws -> String {
        guard let endpoint = URL(string: "/media", relativeTo: backendBaseURL) else {
            throw URLError(.badURL)
        }

        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("video/mp4", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 60
        if let token = SessionStore.sessionToken {
            request.setValue(token, forHTTPHeaderField: "x-session-token")
        }
        // Uploading from a file keeps the clip off the heap; a minute of video
        // read into Data is tens of megabytes the phone does not need to hold.
        let (data, response) = try await URLSession.shared.upload(for: request, fromFile: file)

        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }

        return try JSONDecoder().decode(Response.self, from: data).url
    }

    /// The same upload, given a few chances.
    ///
    /// A recording is a minute of someone's time and there is no second take,
    /// so a phone that dropped to one bar mid-upload is worth waiting out. Four
    /// attempts, backing off, and then nil — never a local `file://` path
    /// dressed up as the card's video, which is what used to happen: the
    /// recipient's phone cannot resolve a path inside the sender's sandbox, so
    /// the card claimed a recording that only one person in the world could
    /// watch.
    static func uploadWithRetries(_ file: URL, to backendBaseURL: URL) async -> String? {
        var delay: UInt64 = 1_000_000_000
        for attempt in 1...4 {
            do {
                return try await upload(file, to: backendBaseURL)
            } catch {
                guard attempt < 4 else { return nil }
                try? await Task.sleep(nanoseconds: delay)
                delay *= 2
            }
        }
        return nil
    }
}
