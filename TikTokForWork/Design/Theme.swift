import SwiftUI
import UIKit

// Shared workbench palette: paper surfaces, ink actions, restrained violet.
// Semantic roles remain stable across native screens and both appearances.
enum Theme {
    enum Colors {
        /// Resolves per interface style, so every call site gets dark for free.
        private static func dyn(_ light: UInt, _ dark: UInt) -> Color {
            Color(uiColor: UIColor { traits in
                UIColor(hex: traits.userInterfaceStyle == .dark ? dark : light)
            })
        }

        static let background = dyn(0xFFFFFF, 0x191C22)
        static let surface = dyn(0xF7F8FA, 0x0F1115)
        static let surfaceRaised = dyn(0xF0F1F5, 0x222631)
        static let textPrimary = dyn(0x20242C, 0xF4F5F7)
        static let textSecondary = dyn(0x626873, 0xB5BDC9)
        static let textTertiary = dyn(0x707683, 0x98A1B0)
        static let accent = dyn(0x6650CB, 0xB4A1FF)
        static let interactive = dyn(0x4268D5, 0x89ACFF)
        static let approve = dyn(0x00885E, 0x67D6A5)
        static let issueGreen = dyn(0x238636, 0x3FB950)
        static let reject = dyn(0xC63B4D, 0xFF8E9D)
        static let border = dyn(0xE5E7ED, 0x2D323D)
        static let ctaFill = dyn(0x252834, 0xF4F5F7)
        static let ctaText = dyn(0xFFFFFF, 0x20242C)
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
        // Compact status badges may use Capsule(); primary controls use
        // restrained rounded rectangles defined by their component.
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
