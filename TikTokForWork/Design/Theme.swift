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

// Visual language v2: deep indigo-biased dark with ambient glow, elevated
// rounded surfaces, gradient accents — and a full light palette. Every
// token is adaptive; views never branch on the color scheme themselves.
enum Theme {
    enum Colors {
        static let background = adaptive(light: 0xF3F4F9, dark: 0x0A0B12)
        static let surface = adaptive(light: 0xFFFFFF, dark: 0x12141D)
        static let surfaceRaised = adaptive(light: 0xEAECF4, dark: 0x1B1E2A)
        static let textPrimary = adaptive(light: 0x171923, dark: 0xF2F3F8)
        static let textSecondary = adaptive(light: 0x555B70, dark: 0x9AA0B4)
        static let textTertiary = adaptive(light: 0x8A90A5, dark: 0x646B80)
        static let accent = adaptive(light: 0x5561D6, dark: 0x6E7BF2)
        static let accentAlt = adaptive(light: 0x7B5BD6, dark: 0x9C6BFF)
        static let approve = adaptive(light: 0x1FA45C, dark: 0x4ADE80)
        static let issueGreen = adaptive(light: 0x1F883D, dark: 0x2EA043)
        static let reject = adaptive(light: 0xE5484D, dark: 0xFF7B87)
        static let warn = adaptive(light: 0xB47D0E, dark: 0xFFC24B)

        static var accentGradient: LinearGradient {
            LinearGradient(
                colors: [accent, accentAlt],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        }
    }

    enum TypeScale {
        static let title = Font.system(size: 24, weight: .semibold, design: .rounded)
        static let body = Font.system(size: 16, weight: .regular)
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

    enum Radius {
        static let sm: CGFloat = 10
        static let md: CGFloat = 14
        static let lg: CGFloat = 22
        static let sheet: CGFloat = 24
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

// Ambient backdrop: canvas color with a soft accent glow bleeding from the
// top — the "alive" quality of the reference visual direction.
struct AppBackdrop: View {
    var body: some View {
        ZStack {
            Theme.Colors.background
            RadialGradient(
                colors: [Theme.Colors.accent.opacity(0.14), .clear],
                center: .top,
                startRadius: 0,
                endRadius: 460
            )
        }
    }
}

extension View {
    func appBackground() -> some View {
        background(AppBackdrop().ignoresSafeArea())
    }

    // Soft brand glow for primary actions and hero elements.
    func accentGlow(_ radius: CGFloat = 16, opacity: Double = 0.35) -> some View {
        shadow(color: Theme.Colors.accent.opacity(opacity), radius: radius, x: 0, y: 6)
    }

    // Elevated rounded card surface with a hairline accent stroke.
    func cardSurface(cornerRadius: CGFloat = Theme.Radius.lg) -> some View {
        background(
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(Theme.Colors.surface)
                .overlay(
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .stroke(Theme.Colors.accent.opacity(0.10), lineWidth: 1)
                )
        )
        .shadow(color: Color.black.opacity(0.22), radius: 22, x: 0, y: 10)
    }
}
