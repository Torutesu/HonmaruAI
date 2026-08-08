import SwiftUI

/// A5 — the one sanctioned dark panel. `docs/design-system.md` keeps the
/// viewfinder at `#111` fading to black while every other surface stays white.
///
/// Speech is a draft: the transcript stays editable, and nothing is routed
/// until it is sent.
struct CaptureView: View {
    @EnvironmentObject private var appState: AppState
    @StateObject private var dictation = DictationService()
    @Environment(\.dismiss) private var dismiss

    @State private var edited = ""
    @State private var isEditing = false

    let onSend: (String) -> Void

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [Color(hex: 0x111111), .black],
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
        .task { await dictation.start() }
        .onDisappear { dictation.stop() }
        .onChange(of: dictation.transcript) { _, new in
            guard !isEditing else { return }
            edited = new
        }
        .alert("エラー", isPresented: errorBinding) {
            Button("OK", role: .cancel) { dictation.errorMessage = nil }
        } message: {
            Text(dictation.errorMessage ?? "")
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
            Button("閉じる") { dismiss() }
                .font(.system(size: 15))
                .foregroundStyle(.white.opacity(0.8))
            Spacer()
            if dictation.isRecording {
                HStack(spacing: 6) {
                    Circle()
                        .fill(Theme.Colors.reject)
                        .frame(width: 7, height: 7)
                    Text("録音中")
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.7))
                }
            }
            Spacer()
            Button("閉じる") {}
                .font(.system(size: 15))
                .opacity(0)
                .disabled(true)
        }
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.top, Theme.Spacing.sm)
    }

    private var transcriptPanel: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("聞き取り中")
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
                        Text("話しかけてください…")
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
                controlButton("消す", systemImage: "arrow.counterclockwise") {
                    dictation.clear()
                    edited = ""
                    isEditing = false
                }
                .disabled(edited.isEmpty)

                recordButton

                controlButton("送る", systemImage: "arrow.up") {
                    let text = edited.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !text.isEmpty else { return }
                    dictation.stop()
                    onSend(text)
                    dismiss()
                }
                .disabled(edited.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }

            Text("話す · 直せる · 送ると AI が宛先を決めます")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(.white.opacity(0.35))
        }
        .padding(.bottom, Theme.Spacing.lg)
    }

    private var recordButton: some View {
        Button {
            if dictation.isRecording {
                dictation.stop()
            } else {
                isEditing = false
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
        .accessibilityLabel(dictation.isRecording ? Text("録音を止める") : Text("録音する"))
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
    CaptureView { _ in }
        .environmentObject(AppState())
}
