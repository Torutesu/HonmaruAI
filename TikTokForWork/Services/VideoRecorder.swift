import AVFoundation
import Foundation

/// Records the capture screen's front-camera video to a file.
///
/// Audio is left to the Speech framework: two clients cannot hold the microphone
/// route at once, and the transcript is what routes the decision, so speech wins.
/// The clip is therefore silent by design.
@MainActor
final class VideoRecorder: NSObject, ObservableObject {
    @Published private(set) var isRecording = false
    @Published private(set) var recordedFile: URL?
    @Published private(set) var errorMessage: String?

    let session = AVCaptureSession()
    private let output = AVCaptureMovieFileOutput()
    private let queue = DispatchQueue(label: "capture.recorder")
    private var finished: ((URL?) -> Void)?
    /// start() was asked for but the camera has not confirmed it yet. The
    /// "Recording" badge reads isRecording, and isRecording only flips when
    /// the file actually opens — a badge without a file is a lie.
    private var startPending = false

    func configure() {
        queue.async { [session, output] in
            guard session.inputs.isEmpty else { return }

            session.beginConfiguration()
            session.sessionPreset = .high

            if let device = AVCaptureDevice.default(
                .builtInWideAngleCamera, for: .video, position: .front
            ), let input = try? AVCaptureDeviceInput(device: device),
               session.canAddInput(input) {
                session.addInput(input)
            }
            if session.canAddOutput(output) {
                session.addOutput(output)
                output.maxRecordedDuration = CMTime(seconds: 60, preferredTimescale: 600)
            }
            session.commitConfiguration()
            session.startRunning()
        }
    }

    func start() {
        guard !isRecording, !startPending else { return }
        startPending = true
        errorMessage = nil
        // A stale file from an earlier take must not be what Send hands back
        // if this one never rolls.
        recordedFile = nil
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("capture-\(UUID().uuidString).mov")

        queue.async { [output, session] in
            guard session.isRunning else {
                DispatchQueue.main.async { self.startFailed() }
                return
            }
            // Mirror the file to match the preview. A clip where you reach left
            // and the video reaches right reads as someone else.
            if let connection = output.connection(with: .video),
               connection.isVideoMirroringSupported {
                connection.automaticallyAdjustsVideoMirroring = false
                connection.isVideoMirrored = true
            }
            DispatchQueue.main.async { output.startRecording(to: url, recordingDelegate: self.delegateProxy) }
        }
    }

    func stop(completion: @escaping (URL?) -> Void) {
        if isRecording {
            finished = completion
            output.stopRecording()
        } else if startPending {
            // The camera is still spinning up. Park the completion — if the
            // file opens, didStart sees it and stops straight away; if the
            // session was never running, startFailed answers it. Without this
            // a fast Send left the card unsent forever.
            finished = completion
        } else {
            completion(recordedFile)
        }
    }

    /// start() bailed before the camera rolled — usually the session had not
    /// finished configuring. Nothing was recorded, so nothing can finish.
    private func startFailed() {
        startPending = false
        errorMessage = String(localized: "Could not start the camera. You can continue with text.")
        finished?(nil)
        finished = nil
    }

    fileprivate func recordingStarted() {
        startPending = false
        isRecording = true
        // Send was pressed while the camera was still opening the file.
        if finished != nil { output.stopRecording() }
    }

    func teardown() {
        queue.async { [session] in
            if session.isRunning { session.stopRunning() }
        }
    }

    private lazy var delegateProxy: Delegate = Delegate(owner: self)

    fileprivate func recordingFinished(_ url: URL?) {
        startPending = false
        isRecording = false
        if url == nil { errorMessage = String(localized: "Could not record video. You can continue with text.") }
        recordedFile = url
        finished?(url)
        finished = nil
    }

    /// A separate object so `VideoRecorder` can stay `@MainActor` while the
    /// callback arrives on a capture queue.
    fileprivate final class Delegate: NSObject, AVCaptureFileOutputRecordingDelegate {
        private weak var owner: VideoRecorder?

        init(owner: VideoRecorder) {
            self.owner = owner
        }

        func fileOutput(
            _ output: AVCaptureFileOutput,
            didStartRecordingTo fileURL: URL,
            from connections: [AVCaptureConnection]
        ) {
            Task { @MainActor [weak owner] in
                owner?.recordingStarted()
            }
        }

        func fileOutput(
            _ output: AVCaptureFileOutput,
            didFinishRecordingTo outputFileURL: URL,
            from connections: [AVCaptureConnection],
            error: Error?
        ) {
            Task { @MainActor [weak owner] in
                owner?.recordingFinished(error == nil ? outputFileURL : nil)
            }
        }
    }
}
