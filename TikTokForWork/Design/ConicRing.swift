import SwiftUI

/// The one expressive moment the design system allows per screen: an 11-stop
/// conic rainbow, used as the border of the ＋ compose button.
///
/// See `docs/design-system.md` — "Conic rainbow border: at most one element per
/// screen". Nothing else in the app may use this gradient.
enum ConicRainbow {
    static let stops: [Gradient.Stop] = [
        .init(color: Color(hex: 0x7D5BE7), location: 0.19),
        .init(color: Color(hex: 0xBC3FDA), location: 0.28),
        .init(color: Color(hex: 0xFA24CE), location: 0.37),
        .init(color: Color(hex: 0xFB49A5), location: 0.45),
        .init(color: Color(hex: 0xFC6D7B), location: 0.52),
        .init(color: Color(hex: 0xFD8461), location: 0.55),
        .init(color: Color(hex: 0xFD9A46), location: 0.58),
        .init(color: Color(hex: 0xF687C6), location: 0.65),
        .init(color: Color(hex: 0xA3A0E0), location: 0.80),
        .init(color: Color(hex: 0x4FB9FA), location: 0.95),
        .init(color: Color(hex: 0x0091FF), location: 1.00),
    ]

    /// `from 90deg` in the CSS token; SwiftUI measures the same angle from the
    /// positive x-axis, so the quarter turn is applied here rather than at each
    /// call site.
    static let gradient = AngularGradient(
        gradient: Gradient(stops: stops),
        center: .center,
        angle: .degrees(90)
    )
}

/// A white circle wrapped by the conic ring.
struct ConicRingCircle: View {
    var diameter: CGFloat = 44
    var lineWidth: CGFloat = 2.5

    var body: some View {
        Circle()
            .fill(Theme.Colors.background)
            .frame(width: diameter, height: diameter)
            .overlay {
                Circle().strokeBorder(ConicRainbow.gradient, lineWidth: lineWidth)
            }
    }
}

#Preview {
    ConicRingCircle()
        .padding(40)
        .background(Theme.Colors.background)
}
