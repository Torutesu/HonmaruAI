import AVFoundation
import SwiftUI

enum CaptureMode: String, Identifiable {
    case dictation, video
    var id: String { rawValue }
}

/// Recording is optional and starts only after an explicit tap. Using a
/// transcript returns to the editable request; it never sends a request.
struct CaptureView: View {
    var mode: CaptureMode = .video
    let onSend: (String, URL?) -> Void
    @StateObject private var dictation = DictationService()
    @StateObject private var recorder = VideoRecorder()
    @Environment(\.dismiss) private var dismiss
    @State private var edited = ""
    @State private var cameraAuthorized = false
    @State private var isStarting = false
    @State private var isFinishing = false
    @State private var isVisible = true
    @State private var cameraError: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    if mode == .video {
                        ZStack {
                            RoundedRectangle(cornerRadius: 20).fill(Color.black)
                            if cameraAuthorized { CameraViewfinder(session: recorder.session).clipShape(RoundedRectangle(cornerRadius: 20)) }
                            else { Label("Camera preview", systemImage: "video").foregroundStyle(.white.opacity(0.8)) }
                        }.frame(height: 250)
                        Text("Video is silent. Your speech is added as an editable transcript.").font(.footnote).foregroundStyle(Theme.Colors.textSecondary)
                    } else {
                        Image(systemName: dictation.isRecording ? "waveform" : "mic")
                            .font(.system(size: 40, weight: .light)).foregroundStyle(Theme.Colors.accent)
                            .frame(maxWidth: .infinity).padding(.vertical, 28)
                        Text("Speak your request, then review the transcript before adding it to your draft.").font(.body).foregroundStyle(Theme.Colors.textSecondary)
                    }
                    HStack(spacing: 8) {
                        Circle().fill(dictation.isRecording ? Theme.Colors.reject : Theme.Colors.textTertiary).frame(width: 7, height: 7)
                        Text(dictation.isRecording ? String(localized: "Recording") : String(localized: "Ready when you are")).font(.subheadline.weight(.medium))
                    }
                    PrimaryButton(title: dictation.isRecording || recorder.isRecording ? String(localized: "Stop recording") : String(localized: "Start recording"), enabled: !isStarting && !isFinishing) {
                        if dictation.isRecording || recorder.isRecording { stop() }
                        else { Task { await start() } }
                    }
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Transcript").font(.subheadline.weight(.semibold))
                        TextEditor(text: $edited).font(.body).frame(minHeight: 150).scrollContentBackground(.hidden)
                            .padding(10).background(Theme.Colors.surface, in: RoundedRectangle(cornerRadius: 12))
                            .disabled(dictation.isRecording).accessibilityLabel("Transcript")
                    }
                    if let error = dictation.errorMessage ?? cameraError ?? recorder.errorMessage {
                        Text(error).font(.subheadline).foregroundStyle(Theme.Colors.reject)
                        Text("You can close this screen and type your request instead.").font(.footnote).foregroundStyle(Theme.Colors.textSecondary)
                    }
                }.padding(24)
            }
            .background(Theme.Colors.background)
            .navigationTitle(mode == .video ? String(localized: "Record video") : String(localized: "Dictate request"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .safeAreaInset(edge: .bottom) {
                PrimaryButton(title: String(localized: "Use transcript"), enabled: !edited.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isFinishing && !isStarting) {
                    isFinishing = true
                    dictation.stop()
                    recorder.stop { file in
                        onSend(edited.trimmingCharacters(in: .whitespacesAndNewlines), mode == .video ? file : nil)
                        dismiss()
                    }
                }.padding(24).background(Theme.Colors.background)
            }
        }
        .tint(Theme.Colors.accent)
        .onChange(of: dictation.transcript) { _, text in edited = text }
        .onDisappear { isVisible = false; dictation.stop(); recorder.stop { _ in }; recorder.teardown() }
        .interactiveDismissDisabled(isFinishing)
    }

    private func start() async {
        isStarting = true
        cameraError = nil
        if mode == .video {
            switch AVCaptureDevice.authorizationStatus(for: .video) {
            case .authorized: cameraAuthorized = true
            case .notDetermined: cameraAuthorized = await AVCaptureDevice.requestAccess(for: .video)
            default: cameraAuthorized = false
            }
            guard isVisible else { isStarting = false; return }
            guard cameraAuthorized else {
                cameraError = String(localized: "Camera access is off. Enable it in Settings or use dictation.")
                isStarting = false
                return
            }
        }
        await dictation.start()
        guard isVisible else { dictation.stop(); isStarting = false; return }
        if mode == .video && dictation.isRecording { recorder.configure(); recorder.start() }
        isStarting = false
    }
    private func stop() { dictation.stop(); recorder.stop { _ in } }
}
