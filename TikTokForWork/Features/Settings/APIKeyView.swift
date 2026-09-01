import SwiftUI

/// Bring your own OpenAI key. It is kept in this device's Keychain and sent with
/// your routing requests — it is never stored on our servers.
struct APIKeyView: View {
    @State private var key: String = ""
    @State private var saved = false

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            Text(String(localized: "Use your own OpenAI key for routing. It stays in this device's Keychain and is sent only with your own requests — we never store it on our servers."))
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textSecondary)

            SecureField("sk-…", text: $key)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(Theme.TypeScale.body)
                .padding(Theme.Spacing.sm)
                .background(Theme.Colors.surface)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.input))
                .overlay {
                    RoundedRectangle(cornerRadius: Theme.Radius.input)
                        .strokeBorder(Theme.Colors.border, lineWidth: 1)
                }

            HStack(spacing: Theme.Spacing.sm) {
                Button(String(localized: "Save")) {
                    SessionStore.apiKey = key.trimmingCharacters(in: .whitespacesAndNewlines)
                    saved = true
                }
                .font(.system(size: 15, weight: .medium))

                Button(String(localized: "Clear")) {
                    key = ""
                    SessionStore.apiKey = nil
                    saved = false
                }
                .font(.system(size: 15))
                .foregroundStyle(Theme.Colors.textSecondary)

                Spacer()

                if saved {
                    Text(String(localized: "Saved"))
                        .font(Theme.TypeScale.micro)
                        .foregroundStyle(Theme.Colors.textTertiary)
                }
            }

            Spacer()
        }
        .padding(Theme.Spacing.md)
        .navigationTitle(Text("API key"))
        .onAppear { key = SessionStore.apiKey ?? "" }
    }
}
