import SwiftUI

enum Theme {
    enum Colors {
        static let background = Color(hex: 0x000000)
        static let surface = Color(hex: 0x0C0C0E)
        static let surfaceRaised = Color(hex: 0x161618)
        static let textPrimary = Color(hex: 0xF4F4F5)
        static let textSecondary = Color(hex: 0xA1A1AA)
        static let textTertiary = Color(hex: 0x71717A)
        static let accent = Color(hex: 0x5E6AD2)
        static let approve = Color(hex: 0x4ADE80)
        static let reject = Color(hex: 0xF87171)
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
