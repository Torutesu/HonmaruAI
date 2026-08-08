import SwiftUI

/// Slack's own palette, kept out of `Theme` on purpose.
///
/// The Classic surface quotes another product, so it uses that product's
/// colours. Anything else in the app using these would be a mistake — see the
/// "Don'ts" in `docs/design-system.md`.
enum Slack {
    static let canvas = Color(hex: 0xFFFFFF)
    static let ink = Color(hex: 0x1D1C1D)
    static let muted = Color(hex: 0x616061)
    static let badge = Color(hex: 0xE01E5A)
    static let presence = Color(hex: 0x2BAC76)
    /// Slack's primary green, used for the confirm action inside the quotation.
    static let confirm = Color(hex: 0x007A5A)
}
