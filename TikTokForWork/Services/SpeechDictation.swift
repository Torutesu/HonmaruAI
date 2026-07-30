import AVFoundation
import Speech
import SwiftUI

@MainActor
final class SpeechRecognizer: ObservableObject {
    @Published private(set) var isRecording = false
    @Published private(set) var transcript = ""
    @Published var errorMessage: String?

    private let recognizer =
        SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var audioEngine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    func start() async {
        guard !isRecording else { return }
        errorMessage = nil
        transcript = ""

        let speechStatus = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }
        guard speechStatus == .authorized else {
            errorMessage = "Speech recognition permission is required — enable it in Settings."
            return
        }

        let micGranted = await AVAudioApplication.requestRecordPermission()
        guard micGranted else {
            errorMessage = "Microphone permission is required — enable it in Settings."
            return
        }

        guard let recognizer, recognizer.isAvailable else {
            errorMessage = "Speech recognition is unavailable on this device."
            return
        }

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)

            let engine = AVAudioEngine()
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            if recognizer.supportsOnDeviceRecognition {
                request.requiresOnDeviceRecognition = true
            }

            let inputNode = engine.inputNode
            let format = inputNode.outputFormat(forBus: 0)
            inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
                request.append(buffer)
            }
            engine.prepare()
            try engine.start()

            audioEngine = engine
            self.request = request
            isRecording = true

            task = recognizer.recognitionTask(with: request) { [weak self] result, error in
                Task { @MainActor in
                    guard let self else { return }
                    if let result {
                        self.transcript = result.bestTranscription.formattedString
                    }
                    if error != nil || result?.isFinal == true {
                        self.stop()
                    }
                }
            }
        } catch {
            errorMessage = error.localizedDescription
            stop()
        }
    }

    func stop() {
        audioEngine?.stop()
        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine = nil
        request?.endAudio()
        request = nil
        task?.finish()
        task = nil
        isRecording = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

// Mic toggle that dictates into a text binding. The transcript lands in the
// field for editing — nothing is sent until the user submits.
struct DictationButton: View {
    @Binding var text: String
    @StateObject private var recognizer = SpeechRecognizer()
    @State private var baseText = ""

    var body: some View {
        Button {
            if recognizer.isRecording {
                recognizer.stop()
            } else {
                Haptics.light()
                baseText = text.trimmingCharacters(in: .whitespacesAndNewlines)
                Task { await recognizer.start() }
            }
        } label: {
            Image(systemName: recognizer.isRecording ? "waveform" : "mic")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(recognizer.isRecording ? Theme.Colors.reject : Theme.Colors.textSecondary)
                .frame(width: 36, height: 36)
                .background(Theme.Colors.surfaceRaised)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
        }
        .onChange(of: recognizer.transcript) { _, newValue in
            guard !newValue.isEmpty else { return }
            text = baseText.isEmpty ? newValue : "\(baseText) \(newValue)"
        }
        .onDisappear { recognizer.stop() }
        .alert(
            "Dictation",
            isPresented: Binding(
                get: { recognizer.errorMessage != nil },
                set: { if !$0 { recognizer.errorMessage = nil } }
            )
        ) {
            Button("OK", role: .cancel) { recognizer.errorMessage = nil }
        } message: {
            Text(recognizer.errorMessage ?? "")
        }
    }
}

// Compact dictation row shown under text editors in sheets.
struct DictationRow: View {
    @Binding var text: String

    var body: some View {
        HStack(spacing: Theme.Spacing.sm) {
            DictationButton(text: $text)
            Text("Dictate — edit before sending")
                .font(Theme.TypeScale.micro)
                .foregroundStyle(Theme.Colors.textTertiary)
            Spacer()
        }
    }
}
