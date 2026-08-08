import Foundation

/// One dictated utterance on its way from the capture screen into the draft
/// chain. The id exists so saying the same thing twice reads as two requests
/// rather than one no-op — `onChange` compares values, not intent.
struct CaptureRequest: Equatable, Identifiable {
    let id: UUID
    let text: String

    init(text: String) {
        self.id = UUID()
        self.text = text
    }
}
