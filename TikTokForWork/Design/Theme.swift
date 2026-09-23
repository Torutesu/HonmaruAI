import SwiftUI
import UIKit

// Figma HonmaruAI Final Screen palette; semantic dark counterparts retained.
// Semantic roles remain stable across native screens and both appearances.
enum Theme {
    enum Colors {
        /// Resolves per interface style, so every call site gets dark for free.
        private static func dyn(_ light: UInt, _ dark: UInt) -> Color {
            Color(uiColor: UIColor { traits in
                UIColor(hex: traits.userInterfaceStyle == .dark ? dark : light)
            })
        }

        // docs/design-system.md, both sides on one neutral scale — the dark
        // side used to be a set of blue-grey guesses (#191C22, #222631,
        // #B5BDC9) that read as a different product from the web's.
        static let background = dyn(0xFFFFFF, 0x0F0F0F)
        static let surface = dyn(0xF8F9FA, 0x1A1A1A)
        static let surfaceRaised = dyn(0xEEEEEE, 0x2A2A2A)
        static let textPrimary = dyn(0x202020, 0xF2F2F2)
        static let textSecondary = dyn(0x646464, 0xA3A3A3)
        static let textTertiary = dyn(0x838383, 0x8A8A8A)
        static let accent = dyn(0x6647F0, 0xB4A1FF)
        static let interactive = dyn(0x0091FF, 0x4FB9FA)
        static let approve = dyn(0x00C07A, 0x6EE7B7)
        static let issueGreen = dyn(0x238636, 0x3FB950)
        static let reject = dyn(0xFA49A5, 0xFF8E9D)
        static let border = dyn(0xE8E8E8, 0x2A2A2A)
        static let ctaFill = dyn(0x202020, 0xF2F2F2)
        static let ctaText = dyn(0xFFFFFF, 0x202020)
    }

    enum TypeScale {
        static let title = Font.system(.title2, design: .default, weight: .semibold)
        static let body = Font.system(.body)
        static let caption = Font.system(.footnote)
        static let label = Font.system(.caption)
        static let micro = Font.system(.caption2)
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
        // Figma entry buttons use Capsule(); individual content surfaces
        // and form controls retain their component-specific corners.
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
