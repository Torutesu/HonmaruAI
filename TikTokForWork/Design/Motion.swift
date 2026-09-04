import SwiftUI
import UIKit

/// Animation, subject to the reader having asked for less of it.
///
/// Reduce Motion is an accessibility setting people turn on because motion
/// makes them ill, and this app moves a lot: cards slide away as they are
/// decided, the feed pages, the swipe hint tracks a finger. None of that
/// checked the setting, so turning it on changed nothing here.
///
/// `withAnimation(nil)` runs the change with no animation at all, which is what
/// these return when the setting is on. The state still changes; it just
/// arrives rather than travels.
enum Motion {
    static var isReduced: Bool { UIAccessibility.isReduceMotionEnabled }

    static func ease(_ duration: Double) -> Animation? {
        isReduced ? nil : .easeOut(duration: duration)
    }

    /// For a delayed step in a sequence. With Reduce Motion the delay goes too:
    /// a staged reveal with no motion is just a stutter.
    static func ease(_ duration: Double, delay: Double) -> Animation? {
        isReduced ? nil : .easeOut(duration: duration).delay(delay)
    }

    static func spring(response: Double, dampingFraction: Double) -> Animation? {
        isReduced ? nil : .spring(response: response, dampingFraction: dampingFraction)
    }
}
