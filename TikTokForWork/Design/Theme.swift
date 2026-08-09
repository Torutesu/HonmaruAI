import SwiftUI
import UIKit

// Light "white marble" system — see docs/design-system.md.
// Canvas white, near-black CTAs, brand violet for badges only,
// interactive blue for selections, pink for destructive.
enum Theme {
    enum Colors {
        /// Resolves per interface style, so every call site gets dark for free.
        private static func dyn(_ light: UInt, _ dark: UInt) -> Color {
            Color(uiColor: UIColor { traits in
                UIColor(hex: traits.userInterfaceStyle == .dark ? dark : light)
            })
        }

        static let background = dyn(0xFFFFFF, 0x0E0E10)
        static let surface = dyn(0xF8F9FA, 0x18181B)
        static let surfaceRaised = dyn(0xEEEEEE, 0x242428)
        static let textPrimary = dyn(0x202020, 0xEDEDED)
        static let textSecondary = dyn(0x646464, 0xA0A0A8)
        static let textTertiary = dyn(0x838383, 0x6E6E76)
        static let accent = dyn(0x6647F0, 0x8A6EFF)
        static let interactive = dyn(0x0091FF, 0x3AA9FF)
        static let approve = dyn(0x00C07A, 0x2BD69A)
        static let issueGreen = dyn(0x238636, 0x3FB950)
        static let reject = dyn(0xFA49A5, 0xFF6FB8)
        static let border = dyn(0xE8E8E8, 0x2E2E33)
        static let ctaFill = dyn(0x202020, 0xEDEDED)
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

extension UIColor {
    convenience init(hex: UInt, alpha: CGFloat = 1) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha
        )
    }
}

extension View {
    func appBackground() -> some View {
        background(Theme.Colors.background.ignoresSafeArea())
    }
}
