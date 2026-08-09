import AVFoundation
import SwiftUI

/// A5 — the one sanctioned dark panel. `docs/design-system.md` keeps the
/// viewfinder at `#111` fading to black while every other surface stays white.
///
/// Speech is a draft: the transcript stays editable, and nothing is routed
/// until it is sent.
struct CaptureView: View {
    @EnvironmentObject private var appState: AppState
    @StateObject private var dictation = DictationService()
    @StateObject private var recorder = VideoRecorder()
    @Environment(\.dismiss) private var dismiss

    @State private var edited = ""
    @State private var isEditing = false
    @State private var cameraAuthorized = false

    /// The transcript, and the clip that was recorded while it was spoken.
    let onSend: (String, URL?) -> Void

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if cameraAuthorized {
                CameraViewfinder(session: recorder.session)
                    .ignoresSafeArea()
            }

            // The sanctioned dark panel from docs/design-system.md, now doing a
            // second job: without a scrim the transcript is unreadable against
            // a bright face.
            LinearGradient(
                colors: [
                    Color(hex: 0x111111).opacity(0.85),
                    Color.black.opacity(0.35),
                    Color.black.opacity(0.9),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea()

            VStack(spacing: 0) {
                topBar
                Spacer()
                transcriptPanel
                Spacer()
                recordControls
            }
        }
        .preferredColorScheme(.dark)
        .task {
            // Camera first: the viewfinder is what makes the screen legible as
            // "you are on", and asking for it after the mic stacks two prompts.
            cameraAuthorized = await Self.requestCamera()
            if cameraAuthorized {
                recorder.configure()
                recorder.start()
            }
            await dictation.start()
        }
        .onDisappear {
            dictation.stop()
            recorder.teardown()
        }
        .onChange(of: dictation.transcript) { _, new in
            guard !isEditing else { return }
            edited = new
        }
        .alert("Error", isPresented: errorBinding) {
            Button("OK", role: .cancel) { dictation.errorMessage = nil }
        } message: {
            Text(dictation.errorMessage ?? "")
        }
    }

    /// Declining the camera is not a failure — the screen still dictates, it
    /// just stops showing you. So this reports rather than throws.
    private static func requestCamera() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .video)
        default: return false
        }
    }

    private var errorBinding: Binding<Bool> {
        Binding(
            get: { dictation.errorMessage != nil },
            set: { if !$0 { dictation.errorMessage = nil } }
        )
    }

    private var topBar: some View {
        HStack {
            Button("Close") { dismiss() }
                .font(.system(size: 15))
                .foregroundStyle(.white.opacity(0.8))
            Spacer()
            if dictation.isRecording || recorder.isRecording {
                HStack(spacing: 6) {
                    Circle()
                        .fill(Theme.Colors.reject)
                        .frame(width: 7, height: 7)
                    Text("Recording")
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.7))
                }
            }
            Spacer()
            Button("Close") {}
                .font(.system(size: 15))
                .opacity(0)
                .disabled(true)
        }
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.top, Theme.Spacing.sm)
    }

    private var transcriptPanel: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("Listening")
                .font(.system(size: 10, weight: .medium, design: .monospaced))
                .tracking(1.2)
                .foregroundStyle(.white.opacity(0.45))
                .padding(.horizontal, 14)
                .padding(.vertical, 5)
                .background(.white.opacity(0.12))
                .clipShape(Capsule())

            TextEditor(text: $edited)
                .font(.system(size: 15))
                .foregroundStyle(.white)
                .scrollContentBackground(.hidden)
                .frame(minHeight: 96, maxHeight: 160)
                .padding(Theme.Spacing.sm)
                .background(.white.opacity(0.10))
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.card))
                .onTapGesture { isEditing = true }
                .overlay(alignment: .topLeading) {
                    if edited.isEmpty {
                        Text("Speak now…")
                            .font(.system(size: 15))
                            .foregroundStyle(.white.opacity(0.35))
                            .padding(.horizontal, 13)
                            .padding(.vertical, 16)
                            .allowsHitTesting(false)
                    }
                }
        }
        .padding(.horizontal, Theme.Spacing.md)
    }

    private var recordControls: some View {
        VStack(spacing: Theme.Spacing.md) {
            HStack(spacing: Theme.Spacing.xl) {
                controlButton("Clear", systemImage: "arrow.counterclockwise") {
                    dictation.clear()
                    edited = ""
                    isEditing = false
                }
                .disabled(edited.isEmpty)

                recordButton

                controlButton("Send", systemImage: "arrow.up") {
                    let text = edited.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !text.isEmpty else { return }
                    dictation.stop()
                    // The movie file is only complete once the recorder says so.
                    // Reading it earlier hands on a truncated clip.
                    recorder.stop { file in
                        onSend(text, file)
                        dismiss()
                    }
                }
                .disabled(edited.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }

            Text("Speak · edit · send, and your AI picks the recipient")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(.white.opacity(0.35))
        }
        .padding(.bottom, Theme.Spacing.lg)
    }

    private var recordButton: some View {
        Button {
            if dictation.isRecording {
                dictation.stop()
                recorder.stop { _ in }
            } else {
                isEditing = false
                if cameraAuthorized { recorder.start() }
                Task { await dictation.start() }
            }
        } label: {
            ZStack {
                Circle()
                    .fill(Theme.Colors.reject)
                    .frame(width: 62, height: 62)
                if dictation.isRecording {
                    RoundedRectangle(cornerRadius: 4)
                        .fill(.white)
                        .frame(width: 20, height: 20)
                }
            }
        }
        .accessibilityLabel(dictation.isRecording ? Text("Stop recording") : Text("Record"))
    }

    private func controlButton(
        _ label: String,
        systemImage: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(spacing: 4) {
                Image(systemName: systemImage)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(.white)
                    .frame(width: 42, height: 42)
                    .background(.white.opacity(0.12))
                    .clipShape(Circle())
                Text(label)
                    .font(.system(size: 10))
                    .foregroundStyle(.white.opacity(0.6))
            }
        }
        .opacity(0.999)
    }
}

#Preview {
    CaptureView { _, _ in }
        .environmentObject(AppState())
}
