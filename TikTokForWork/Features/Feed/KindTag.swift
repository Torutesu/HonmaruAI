import SwiftUI

/// The card's kind, as a mono uppercase chip.
///
/// `docs/design-system.md` maps the kinds onto emerald / blue / violet / ash.
/// The tint is the only colour on the chip — the fill stays a wash of it, so a
/// row of cards reads as one family rather than a set of buttons.
struct KindTag: View {
    let type: CardType

    var body: some View {
        Text(type.label.uppercased())
            .font(.system(size: 10, weight: .medium, design: .monospaced))
            .tracking(0.8)
            .foregroundStyle(tint)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(tint.opacity(0.10))
            .clipShape(Capsule())
    }

    private var tint: Color {
        switch type {
        case .approval:     Theme.Colors.approve          // emerald
        case .task:         Theme.Colors.interactive      // blue
        case .delegation:   Theme.Colors.accent           // violet
        case .revision:     Theme.Colors.accent
        case .notification: Theme.Colors.textTertiary     // ash
        }
    }
}

/// Initials on a quiet fill. Avatars stay neutral so the kind tag and the
/// priority dot remain the only colour in the card header.
struct SenderAvatar: View {
    let name: String
    var diameter: CGFloat = 22

    var body: some View {
        Text(initials)
            .font(.system(size: diameter * 0.4, weight: .semibold))
            .foregroundStyle(Theme.Colors.textSecondary)
            .frame(width: diameter, height: diameter)
            .background(Theme.Colors.surfaceRaised)
            .clipShape(Circle())
            // The sender's initials, next to the sender's name. Read aloud it
            // was "D K, Dana Kim" every time.
            .accessibilityHidden(true)
    }

    private var initials: String {
        let parts = name.split(separator: " ").prefix(2)
        let letters = parts.compactMap(\.first).map(String.init).joined()
        return letters.isEmpty ? String(name.prefix(1)) : letters
    }
}

#Preview {
    VStack(alignment: .leading, spacing: 12) {
        ForEach(CardType.allCases, id: \.self) { KindTag(type: $0) }
        SenderAvatar(name: "Dana Kim")
    }
    .padding()
    .background(Theme.Colors.background)
}
