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
    /// `orgID` is the workspace the card is for: the Worker keeps the clip
    /// under it (and checks the caller belongs to it).
    static func upload(_ file: URL, to backendBaseURL: URL, orgID: String? = nil) async throws -> String {
        guard var components = URLComponents(url: URL(string: "/media", relativeTo: backendBaseURL)?.absoluteURL ?? backendBaseURL, resolvingAgainstBaseURL: true) else {
            throw URLError(.badURL)
        }
        if let orgID, !orgID.isEmpty { components.queryItems = [URLQueryItem(name: "orgId", value: orgID)] }
        guard let endpoint = components.url else { throw URLError(.badURL) }

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
}
