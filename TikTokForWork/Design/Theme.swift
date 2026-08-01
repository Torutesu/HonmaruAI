import SwiftUI
import UIKit

// Appearance setting: System / Dark / Light, persisted via @AppStorage
// ("appearanceMode") and applied at the root with preferredColorScheme.
enum AppearanceMode: String, CaseIterable, Identifiable {
    case system
    case dark
    case light

    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: "System"
        case .dark: "Dark"
        case .light: "Light"
        }
    }

    var icon: String {
        switch self {
        case .system: "circle.lefthalf.filled"
        case .dark: "moon.fill"
        case .light: "sun.max.fill"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .dark: .dark
        case .light: .light
        }
    }
}

// Visual language v3 — calm.
//
// v2 was loud: an ambient purple glow behind every screen, a saturated green
// primary fighting a violet accent, 22pt radii and a rounded display face.
// The rule now is that colour carries meaning and never decoration; hierarchy
// comes from spacing, weight and one accent used sparingly.
//
// Kept in sync with web/src/styles/tokens.css. Every token is adaptive; views
// never branch on the color scheme themselves.
enum Theme {
    enum Colors {
        static let background = adaptive(light: 0xFBFBFC, dark: 0x0B0C0E)
        static let surface = adaptive(light: 0xFFFFFF, dark: 0x141518)
        static let surfaceRaised = adaptive(light: 0xF2F3F5, dark: 0x1C1E22)
        static let textPrimary = adaptive(light: 0x16181C, dark: 0xECEDEF)
        static let textSecondary = adaptive(light: 0x5C626C, dark: 0x9EA3AB)
        static let textTertiary = adaptive(light: 0x8B919B, dark: 0x6B7078)
        static let accent = adaptive(light: 0x4F5BD5, dark: 0x7C8CF8)
        static let accentStrong = adaptive(light: 0x4049C4, dark: 0x6474F0)
        // The gradient partner is gone — aliased so call sites keep compiling.
        static let accentAlt = accent
        static let approve = adaptive(light: 0x1A8245, dark: 0x3FB96B)
        // The primary action is the accent now; a saturated green next to a
        // violet accent was two unrelated hues competing on one card.
        static let issueGreen = accentStrong
        static let reject = adaptive(light: 0xC9333C, dark: 0xE5646E)
        static let warn = adaptive(light: 0x9A6B0C, dark: 0xD9A441)

        // Flat: kept as a LinearGradient so existing call sites compile, but
        // it is a single colour.
        static var accentGradient: LinearGradient {
            LinearGradient(colors: [accentStrong, accentStrong], startPoint: .top, endPoint: .bottom)
        }
    }

    // One family throughout. The rounded display face was the loudest part
    // of v2 and it made a decision tool read as a game.
    enum TypeScale {
        static let title = Font.system(size: 21, weight: .semibold)
        static let body = Font.system(size: 15, weight: .regular)
        static let caption = Font.system(size: 13, weight: .regular)
        static let label = Font.system(size: 12, weight: .medium)
        static let micro = Font.system(size: 11, weight: .regular)
    }

    enum Spacing {
        static let xs: CGFloat = 4
        static let sm: CGFloat = 8
        static let md: CGFloat = 16
        static let lg: CGFloat = 24
        static let xl: CGFloat = 32
        static let xxl: CGFloat = 48
        static let screen: CGFloat = 24
    }

    // 22pt read as a toy; 8–12 reads as a tool.
    enum Radius {
        static let sm: CGFloat = 6
        static let md: CGFloat = 8
        static let lg: CGFloat = 12
        static let sheet: CGFloat = 16
    }
}

private func adaptive(light: UInt, dark: UInt) -> Color {
    Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light)
    })
}

extension UIColor {
    convenience init(hex: UInt) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1
        )
    }
}

extension Color {
    init(hex: UInt, opacity: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity
        )
    }
}

// The backdrop is flat on purpose. v2 bled an accent glow from the top of
// every screen; it made the app look like a landing page and competed with
// the content it was supposed to hold.
struct AppBackdrop: View {
    var body: some View {
        Theme.Colors.background
    }
}

extension View {
    func appBackground() -> some View {
        background(AppBackdrop().ignoresSafeArea())
    }

    // Kept so call sites compile, but glow is not part of v3: a primary
    // action earns attention by being the only accent on the screen.
    func accentGlow(_ radius: CGFloat = 16, opacity: Double = 0.35) -> some View {
        self
    }

    // A card is a surface with a hairline, not a floating slab. The heavy
    // drop shadow in v2 did the work that spacing should do.
    func cardSurface(cornerRadius: CGFloat = Theme.Radius.lg) -> some View {
        background(
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(Theme.Colors.surface)
                .overlay(
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .stroke(Theme.Colors.textPrimary.opacity(0.08), lineWidth: 1)
                )
        )
        .shadow(color: Color.black.opacity(0.18), radius: 2, x: 0, y: 1)
    }
}
