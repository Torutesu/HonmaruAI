import SwiftUI

// Light "white marble" system — see docs/design-system.md.
// Canvas white, near-black CTAs, brand violet for badges only,
// interactive blue for selections, pink for destructive.
enum Theme {
    enum Colors {
        static let background = Color(hex: 0xFFFFFF)
        static let surface = Color(hex: 0xF8F9FA)
        static let surfaceRaised = Color(hex: 0xEEEEEE)
        static let textPrimary = Color(hex: 0x202020)
        static let textSecondary = Color(hex: 0x646464)
        static let textTertiary = Color(hex: 0x838383)
        static let accent = Color(hex: 0x6647F0)
        static let interactive = Color(hex: 0x0091FF)
        static let approve = Color(hex: 0x00C07A)
        static let issueGreen = Color(hex: 0x238636)
        static let reject = Color(hex: 0xFA49A5)
        static let border = Color(hex: 0xE8E8E8)
        static let ctaFill = Color(hex: 0x202020)
    }

    enum TypeScale {
        static let title = Font.system(size: 26, weight: .medium, design: .default)
        static let body = Font.system(size: 17, weight: .regular)
        static let caption = Font.system(size: 13, weight: .regular)
        static let label = Font.system(size: 12, weight: .regular)
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

    enum Radius {
        static let sm: CGFloat = 6
        static let md: CGFloat = 10
        static let sheet: CGFloat = 14
        // From docs/design-system.md. Buttons and badges are pills, so they use
        // Capsule() rather than a radius.
        static let input: CGFloat = 9
        static let card: CGFloat = 12
        static let largeCard: CGFloat = 20
        static let image: CGFloat = 16
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

extension View {
    func appBackground() -> some View {
        background(Theme.Colors.background.ignoresSafeArea())
    }
}
