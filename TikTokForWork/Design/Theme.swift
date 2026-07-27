import SwiftUI

enum Theme {
    enum Colors {
        static let background = Color(hex: 0x09090B)
        static let surface = Color(hex: 0x111113)
        static let surfaceRaised = Color(hex: 0x18181B)
        static let textPrimary = Color(hex: 0xEDEDEF)
        static let textSecondary = Color(hex: 0x8B8B93)
        static let textTertiary = Color(hex: 0x5C5C63)
        static let accent = Color(hex: 0x5E6AD2)
        static let approve = Color(hex: 0x4ADE80)
        static let reject = Color(hex: 0xF87171)
    }

    enum Spacing {
        static let xs: CGFloat = 4
        static let sm: CGFloat = 8
        static let md: CGFloat = 16
        static let lg: CGFloat = 24
        static let xl: CGFloat = 32
        static let screen: CGFloat = 20
    }

    enum Radius {
        static let sm: CGFloat = 4
        static let sheet: CGFloat = 12
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
