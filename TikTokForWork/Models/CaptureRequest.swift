import Foundation

/// One dictated utterance on its way from the capture screen into the draft
/// chain. The id exists so saying the same thing twice reads as two requests
/// rather than one no-op — `onChange` compares values, not intent.
struct CaptureRequest: Equatable, Identifiable {
    let id: UUID
    let text: String
    /// Set once the clip is on the relay. Nil when there was no video, or when
    /// the upload failed — either way the decision still routes.
    let videoURL: String?

    init(text: String, videoURL: String? = nil) {
        self.id = UUID()
        self.text = text
        self.videoURL = videoURL
    }
}
