import AVFoundation
import Foundation
import Speech

/// On-device dictation for the capture screen.
///
/// The transcript is deliberately editable before it is sent: speech recognition
/// is a draft, not a command. Recognition must stay on-device. Unsupported
/// devices/locales use typed input, never server-based speech recognition.
@MainActor
final class DictationService: ObservableObject {
    enum Failure: LocalizedError {
        case denied
        case unavailable

        var errorDescription: String? {
            switch self {
            case .denied:      String(localized: "Microphone or speech access is off. Turn it on in Settings.")
            case .unavailable: String(localized: "Dictation is unavailable on this device.")
            }
        }
    }

    @Published private(set) var transcript = ""
    @Published private(set) var isRecording = false
    @Published var errorMessage: String?

    private let audioEngine = AVAudioEngine()
    private var hasInputTap = false
    private var isStarting = false
    private var recordingGeneration = UUID()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private lazy var recognizer = SFSpeechRecognizer(locale: Locale.current)
        ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))

    /// Set before the first await in `start()`. Two callers arrive at once —
    /// the screen's `.task` and the record button — and `isRecording` is only
    /// true after the permission prompt, so both used to get past the guard
    /// and the second installed a second tap on the input bus, which traps.
    private var isStarting = false

    func start() async {
        guard !isRecording, !isStarting else { return }
        isStarting = true
        recordingGeneration = UUID()
        let generation = recordingGeneration
        defer { if recordingGeneration == generation { isStarting = false } }
        transcript = ""
        errorMessage = nil

        do {
            guard let recognizer, recognizer.supportsOnDeviceRecognition else { throw Failure.unavailable }
            try await requestAccess()
            guard recordingGeneration == generation else { return }
            try Task.checkCancellation()
            try beginSession()
            isRecording = true
        } catch {
            guard recordingGeneration == generation else { return }
            errorMessage = error.localizedDescription
            stop()
        }
    }

    func stop() {
        recordingGeneration = UUID()
        // Order matters: detach the tap before stopping the engine, or the tap
        // outlives the node and the next start() traps on a duplicate install.
        if hasInputTap {
            audioEngine.inputNode.removeTap(onBus: 0)
            hasInputTap = false
        }
        audioEngine.stop()
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        isRecording = false
        isStarting = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    func clear() {
        transcript = ""
    }

    // MARK: - Private

    private func requestAccess() async throws {
        let speech = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard speech == .authorized else { throw Failure.denied }

        let mic = await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
        }
        guard mic else { throw Failure.denied }
    }

    private func beginSession() throws {
        guard let recognizer, recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else { throw Failure.unavailable }
        let generation = recordingGeneration

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: .duckOthers)
        try session.setActive(true, options: .notifyOthersOnDeactivation)

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = true
        self.request = request

        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw Failure.unavailable }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }
        hasInputTap = true

        audioEngine.prepare()
        try audioEngine.start()

        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                guard let self, self.recordingGeneration == generation else { return }
                if let result {
                    self.transcript = result.bestTranscription.formattedString
                }
                if error != nil || result?.isFinal == true {
                    self.stop()
                }
            }
        }
    }
}
