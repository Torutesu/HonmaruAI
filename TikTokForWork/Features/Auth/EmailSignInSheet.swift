import SwiftUI

/// Email, then the six digits that arrive there.
///
/// Two steps in one sheet rather than two screens, because the second one is
/// only ever reached from the first and going back is a correction, not
/// navigation.
struct EmailSignInSheet: View {
    /// Called with the session, once the code checks out.
    let onSignedIn: (EmailAuthService.Session, String) -> Void

    @Environment(\.dismiss) private var dismiss
    @FocusState private var focus: Field?

    private enum Field: Hashable { case email, name, invite, code }
    private enum Step { case address, code }

    @State private var step: Step = .address
    @State private var email = ""
    @State private var name = ""
    @State private var inviteCode = ""
    @State private var code = ""
    @State private var busy = false
    @State private var errorMessage: String?
    @State private var resendIn = 0
    @State private var ticker: Task<Void, Never>?

    private var emailLooksReal: Bool {
        let value = email.trimmingCharacters(in: .whitespaces)
        guard let at = value.firstIndex(of: "@"), at != value.startIndex else { return false }
        return value[value.index(after: at)...].contains(".")
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                switch step {
                case .address: addressStep
                case .code: codeStep
                }

                if let errorMessage {
                    Text(errorMessage)
                        .font(Theme.TypeScale.label)
                        .foregroundStyle(Theme.Colors.reject)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer()

                PrimaryButton(title: primaryTitle, enabled: primaryEnabled && !busy) {
                    Task { await primaryAction() }
                }
                .overlay { if busy { ProgressView().tint(Theme.Colors.background) } }

                if step == .code {
                    Button {
                        Task { await resend() }
                    } label: {
                        Text(resendIn > 0
                             ? String(localized: "Send another code in \(resendIn)s")
                             : String(localized: "Send another code"))
                            .font(Theme.TypeScale.label)
                            .foregroundStyle(Theme.Colors.textSecondary)
                    }
                    .disabled(resendIn > 0 || busy)
                    .frame(maxWidth: .infinity)
                }
            }
            .padding(Theme.Spacing.screen)
            .background(Theme.Colors.background)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(step == .code ? String(localized: "Back") : String(localized: "Cancel")) {
                        if step == .code { step = .address; errorMessage = nil } else { dismiss() }
                    }
                }
            }
        }
        .onAppear { focus = .email }
        .onDisappear { ticker?.cancel() }
    }

    // MARK: - Steps

    private var addressStep: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            Text("Sign in with email")
                .font(.system(size: 24, weight: .medium))
                .foregroundStyle(Theme.Colors.textPrimary)
            Text("We send a six-digit code. Nothing to remember, and it proves where your decisions should reach you.")
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)

            field(String(localized: "Email"), text: $email, field: .email)
                .keyboardType(.emailAddress)
                .textContentType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()

            field(String(localized: "Your name"), text: $name, field: .name)
                .textContentType(.name)

            field(String(localized: "Invite code (optional)"), text: $inviteCode, field: .invite)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()

            Text("No code? You get a workspace of your own, and can invite people into it. Your name is only used if this address is new here.")
                .font(Theme.TypeScale.micro)
                .foregroundStyle(Theme.Colors.textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var codeStep: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            Text("Enter the code")
                .font(.system(size: 24, weight: .medium))
                .foregroundStyle(Theme.Colors.textPrimary)
            Text("We sent six digits to \(email.trimmingCharacters(in: .whitespaces)). It is good for ten minutes, once.")
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)

            TextField("000000", text: $code)
                .font(.system(size: 30, weight: .medium, design: .monospaced))
                .kerning(10)
                .multilineTextAlignment(.center)
                .keyboardType(.numberPad)
                .textContentType(.oneTimeCode)
                .focused($focus, equals: .code)
                .padding(.vertical, Theme.Spacing.md)
                .frame(maxWidth: .infinity)
                .background(Theme.Colors.surface)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.input, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.input, style: .continuous)
                        .stroke(Theme.Colors.border, lineWidth: 1)
                )
                .onChange(of: code) { _, value in
                    // Digits only, six of them, and submit as soon as they are
                    // there — a Continue button under a full code is a step
                    // that exists only to be pressed.
                    let digits = String(value.filter(\.isNumber).prefix(6))
                    if digits != value { code = digits }
                    if digits.count == 6, !busy { Task { await verify() } }
                }
        }
    }

    private func field(_ label: String, text: Binding<String>, field: Field) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(Theme.TypeScale.label)
                .foregroundStyle(Theme.Colors.textSecondary)
            TextField("", text: text)
                .font(Theme.TypeScale.body)
                .focused($focus, equals: field)
                .padding(.horizontal, Theme.Spacing.md)
                .frame(height: 48)
                .background(Theme.Colors.surface)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.input, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.input, style: .continuous)
                        .stroke(Theme.Colors.border, lineWidth: 1)
                )
        }
    }

    // MARK: - Actions

    private var primaryTitle: String {
        step == .address ? String(localized: "Email me a code") : String(localized: "Continue")
    }
    private var primaryEnabled: Bool {
        step == .address ? emailLooksReal : code.count == 6
    }

    private func primaryAction() async {
        step == .address ? await sendCode() : await verify()
    }

    private func sendCode() async {
        busy = true
        errorMessage = nil
        defer { busy = false }
        do {
            try await EmailAuthService.requestCode(email: email.trimmingCharacters(in: .whitespaces))
            step = .code
            focus = .code
            startResendCountdown()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func resend() async {
        busy = true
        errorMessage = nil
        defer { busy = false }
        do {
            try await EmailAuthService.requestCode(email: email.trimmingCharacters(in: .whitespaces))
            code = ""
            startResendCountdown()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func verify() async {
        busy = true
        errorMessage = nil
        defer { busy = false }
        do {
            let session = try await EmailAuthService.verifyCode(
                email: email.trimmingCharacters(in: .whitespaces),
                code: code,
                name: name.trimmingCharacters(in: .whitespaces),
                inviteCode: inviteCode.trimmingCharacters(in: .whitespaces)
            )
            onSignedIn(session, name.trimmingCharacters(in: .whitespaces))
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
            code = ""
        }
    }

    /// The server refuses a resend for a minute. Counting it down here is the
    /// difference between a disabled button and a button that seems broken.
    private func startResendCountdown() {
        ticker?.cancel()
        resendIn = 60
        ticker = Task {
            while !Task.isCancelled, resendIn > 0 {
                try? await Task.sleep(for: .seconds(1))
                if Task.isCancelled { return }
                resendIn -= 1
            }
        }
    }
}
