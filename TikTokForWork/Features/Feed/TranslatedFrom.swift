import SwiftUI

/// Marks a card whose sender wrote in another language, and lets you read what
/// they actually said.
///
/// The badge is not decoration. You are approving someone else's words, and a
/// translation you cannot check is a translation you have to trust blindly —
/// so the original is one tap away, never further.
struct TranslatedFrom: View {
    let language: String
    let original: String

    @State private var showsOriginal = false

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Button {
                showsOriginal.toggle()
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "character.bubble")
                        .font(.system(size: 10, weight: .semibold))
                    Text("Translated from \(displayLanguage)")
                        .font(.system(size: 10, weight: .medium, design: .monospaced))
                        .tracking(0.5)
                    Image(systemName: showsOriginal ? "chevron.up" : "chevron.down")
                        .font(.system(size: 8, weight: .semibold))
                }
                .foregroundStyle(Theme.Colors.accent)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(Theme.Colors.accent.opacity(0.10))
                .clipShape(Capsule())
            }
            .buttonStyle(.plain)

            if showsOriginal {
                Text(original)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.Colors.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(Theme.Spacing.sm)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.Colors.surface)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                    .transition(.opacity)
            }
        }
        .animation(Motion.ease(0.15), value: showsOriginal)
    }

    private var displayLanguage: String {
        Locale.current.localizedString(forLanguageCode: language)
            ?? language.uppercased()
    }
}
