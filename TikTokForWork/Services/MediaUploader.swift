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
        // Uploading from a file keeps the clip off the heap; a minute of video
        // read into Data is tens of megabytes the phone does not need to hold.
        let (data, response) = try await URLSession.shared.upload(for: request, fromFile: file)

        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }

        return try JSONDecoder().decode(Response.self, from: data).url
    }
}
