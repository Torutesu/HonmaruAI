import SwiftUI
import UIKit

// Light-first token set matching the web client; dark follows the OS.
enum Theme {
    enum Colors {
        static let background = adaptive(light: 0xF6F6F7, dark: 0x101012)
        static let surface = adaptive(light: 0xFFFFFF, dark: 0x17171A)
        static let surfaceRaised = adaptive(light: 0xF1F1F3, dark: 0x1F1F23)
        static let textPrimary = adaptive(light: 0x1C1C21, dark: 0xEDEDEF)
        static let textSecondary = adaptive(light: 0x62626C, dark: 0x9B9BA4)
        static let textTertiary = adaptive(light: 0x94949E, dark: 0x67676F)
        static let accent = adaptive(light: 0x5E6AD2, dark: 0x7581E0)
        static let approve = adaptive(light: 0x17843B, dark: 0x4ADE80)
        static let issueGreen = adaptive(light: 0x238636, dark: 0x2EA043)
        static let reject = adaptive(light: 0xC4322E, dark: 0xF87171)

        private static func adaptive(light: UInt, dark: UInt) -> Color {
            Color(
                uiColor: UIColor { trait in
                    trait.userInterfaceStyle == .dark
                        ? UIColor(hex: dark)
                        : UIColor(hex: light)
                }
            )
        }
    }

    enum TypeScale {
        static let title = Font.system(size: 22, weight: .medium, design: .default)
        static let body = Font.system(size: 15, weight: .regular)
        static let caption = Font.system(size: 12.5, weight: .regular)
        static let label = Font.system(size: 11.5, weight: .regular)
        static let micro = Font.system(size: 10.5, weight: .regular)
    }

    enum Spacing {
        static let xs: CGFloat = 4
        static let sm: CGFloat = 8
        static let md: CGFloat = 14
        static let lg: CGFloat = 20
        static let xl: CGFloat = 28
        static let xxl: CGFloat = 40
        static let screen: CGFloat = 20
    }

    enum Radius {
        static let sm: CGFloat = 6
        static let md: CGFloat = 10
        static let sheet: CGFloat = 14
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
    convenience init(hex: UInt) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1
        )
    }
}

extension View {
    func appBackground() -> some View {
        background(Theme.Colors.background.ignoresSafeArea())
    }
}
