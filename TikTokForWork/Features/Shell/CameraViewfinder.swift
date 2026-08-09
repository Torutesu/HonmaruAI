import AVFoundation
import SwiftUI

/// Live front-camera preview for the capture screen.
///
/// The preview is mirrored, because a face that moves the wrong way reads as
/// wrong even when people cannot say why. `VideoRecorder` mirrors the recorded
/// file to match, so what you saw is what you sent.
struct CameraViewfinder: UIViewRepresentable {
    /// The recorder owns the session: preview and file have to come from the
    /// same one, because the camera cannot be held twice.
    let session: AVCaptureSession

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.backgroundColor = .black
        view.previewLayer.session = session
        view.previewLayer.videoGravity = .resizeAspectFill
        view.previewLayer.connection?.automaticallyAdjustsVideoMirroring = false
        view.previewLayer.connection?.isVideoMirrored = true
        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {}

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }
}
