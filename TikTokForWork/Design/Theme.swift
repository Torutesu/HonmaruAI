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
        // Used at 11 and 12 point, where WCAG counts it as normal text and asks
        // for 4.5:1. It was 3.8:1 in light and 3.7:1 in dark — the timestamps,
        // the waiting counter and the source line were all below the line. This
        // is 4.5:1 and 5.1:1, and still clearly lighter than textSecondary.
        static let textTertiary = dyn(0x767676, 0x82828A)
        static let accent = dyn(0x6647F0, 0x8A6EFF)
        static let interactive = dyn(0x0091FF, 0x3AA9FF)
        static let approve = dyn(0x00C07A, 0x2BD69A)
        static let issueGreen = dyn(0x238636, 0x3FB950)
        static let reject = dyn(0xFA49A5, 0xFF6FB8)
        static let border = dyn(0xE8E8E8, 0x2E2E33)
        static let ctaFill = dyn(0x202020, 0xEDEDED)
    }

    /// Typography, tied to the reader's text size.
    ///
    /// These were `Font.system(size:)`, which in SwiftUI is a fixed point size
    /// and does not respond to Dynamic Type at all — so a person who had turned
    /// their text up got the same 11pt caption as everyone else, everywhere in
    /// the app. Naming the text style instead scales them, and at the default
    /// setting the sizes are within a point or two of what they were.
    enum TypeScale {
        static let title = Font.system(.title, design: .default, weight: .medium)
        static let body = Font.system(.body, weight: .regular)
        static let caption = Font.system(.footnote, weight: .regular)
        static let label = Font.system(.caption, weight: .regular)
        static let micro = Font.system(.caption2, weight: .regular)
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
