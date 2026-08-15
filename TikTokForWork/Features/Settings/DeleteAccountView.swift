import SwiftUI

/// Deleting an account, in the app, because Apple requires it of anything that
/// lets you create one (Guideline 5.1.1(v)) — and because an account you cannot
/// leave is not really yours.
///
/// The screen's job is to be unambiguous rather than difficult. It says exactly
/// what goes and exactly what stays before asking, and it asks for the word
/// "DELETE" rather than a second "are you sure?" — a confirmation you can tap
/// through by reflex is not a confirmation.
struct DeleteAccountView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss

    @State private var confirmation = ""
    @State private var isDeleting = false
    @State private var errorMessage: String?

    private let requiredWord = "DELETE"

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    Text("Delete your account")
                        .font(.system(size: 22, weight: .medium))
                        .foregroundStyle(Theme.Colors.textPrimary)
                    Text("This cannot be undone.")
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.Colors.textSecondary)
                }

                section(String(localized: "What is deleted"), items: [
                    String(localized: "Your profile and sign-in"),
                    String(localized: "Decisions waiting for you"),
                    String(localized: "Your context and connector settings"),
                    String(localized: "Your subscription entitlement record"),
                ])

                section(String(localized: "What stays"), items: [
                    String(localized: "Decisions your teammates still have to make, with your name removed"),
                    String(localized: "The team's history of what was decided, with your name removed"),
                    String(localized: "GitHub issues already created — delete those on GitHub"),
                ])

                VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                    Text("Type \(requiredWord) to confirm")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.Colors.textSecondary)
                    TextField("", text: $confirmation)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .font(.system(size: 16))
                        .padding(.horizontal, Theme.Spacing.md)
                        .padding(.vertical, 12)
                        .background(Theme.Colors.surfaceRaised)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.image))
                        .accessibilityLabel(Text("Confirmation"))
                }

                if let errorMessage {
                    Text(errorMessage)
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.Colors.reject)
                }

                Button {
                    Task { await delete() }
                } label: {
                    HStack {
                        Spacer()
                        if isDeleting {
                            ProgressView().tint(.white)
                        } else {
                            Text("Delete account")
                                .font(.system(size: 15, weight: .medium))
                        }
                        Spacer()
                    }
                    .padding(.vertical, 14)
                    .background(canDelete ? Theme.Colors.reject : Theme.Colors.surfaceRaised)
                    .foregroundStyle(canDelete ? .white : Theme.Colors.textTertiary)
                    .clipShape(Capsule())
                }
                .buttonStyle(.plain)
                .disabled(!canDelete || isDeleting)
            }
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, Theme.Spacing.lg)
        }
        .background(Theme.Colors.background)
        .navigationTitle(Text("Delete account"))
        .navigationBarTitleDisplayMode(.inline)
    }

    private var canDelete: Bool {
        confirmation.trimmingCharacters(in: .whitespaces).uppercased() == requiredWord
    }

    private func section(_ title: String, items: [String]) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text(title)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Theme.Colors.textSecondary)
            ForEach(items, id: \.self) { item in
                HStack(alignment: .top, spacing: 8) {
                    Text("·").foregroundStyle(Theme.Colors.textTertiary)
                    Text(item)
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Colors.background)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.image))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.Radius.image)
                .strokeBorder(Theme.Colors.border, lineWidth: 1)
        }
    }

    private func delete() async {
        isDeleting = true
        errorMessage = nil
        do {
            try await appState.deleteAccount()
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
        isDeleting = false
    }
}

#Preview {
    NavigationStack {
        DeleteAccountView().environmentObject(AppState())
    }
}
