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

    let session = AVCaptureSession()
    private let output = AVCaptureMovieFileOutput()
    private let queue = DispatchQueue(label: "capture.recorder")
    private var finished: ((URL?) -> Void)?

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
        guard !isRecording else { return }
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("capture-\(UUID().uuidString).mov")

        queue.async { [weak self, output, session] in
            // No running session, or a session with no camera on it (the
            // input could not be added, another app holds the device): nothing
            // will record. Saying "recording" anyway left Send with a
            // completion that never fired, and calling startRecording with no
            // video connection raises an Objective-C exception.
            guard session.isRunning, output.connection(with: .video) != nil else {
                Task { @MainActor in self?.isRecording = false }
                return
            }
            // Mirror the file to match the preview. A clip where you reach left
            // and the video reaches right reads as someone else.
            if let connection = output.connection(with: .video),
               connection.isVideoMirroringSupported {
                connection.automaticallyAdjustsVideoMirroring = false
                connection.isVideoMirrored = true
            }
            DispatchQueue.main.async { [weak self] in
                guard let self, self.isRecording else { return }
                output.startRecording(to: url, recordingDelegate: self.delegateProxy)
            }
        }
        isRecording = true
    }

    func stop(completion: @escaping (URL?) -> Void) {
        // "Recording" that never started has nothing to stop, and waiting on
        // a delegate that will never be called is a Send button that does
        // nothing. Answer now with whatever there is.
        guard isRecording, output.isRecording else {
            isRecording = false
            completion(recordedFile)
            return
        }
        finished = completion
        output.stopRecording()
    }

    func teardown() {
        queue.async { [session] in
            if session.isRunning { session.stopRunning() }
        }
    }

    private lazy var delegateProxy: Delegate = Delegate(owner: self)

    fileprivate func recordingFinished(_ url: URL?) {
        isRecording = false
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
