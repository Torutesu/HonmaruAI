import Foundation
import SwiftUI

enum DateFormatting {
    private static let relative: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter
    }()

    static func relative(_ date: Date) -> String {
        relative.localizedString(for: date, relativeTo: .now)
    }

    /// How long ago, as a chat app says it: "now", "10 min. ago",
    /// "2 hr., 38 min. ago", "3 days ago" — to the minute, never the second.
    /// `Text(date, style: .relative)` counts the seconds as they pass
    /// ("10 min, 50 sec"), which nobody reading a list needs.
    static func ago(_ date: Date, now: Date = .now, locale: Locale = .autoupdatingCurrent) -> String {
        let minutes = max(0, Int(now.timeIntervalSince(date) / 60))
        let words = RelativeDateTimeFormatter()
        words.unitsStyle = .short
        words.locale = locale
        if minutes < 1 {
            words.dateTimeStyle = .named
            return words.localizedString(from: DateComponents(second: 0))
        }
        if minutes < 60 { return words.localizedString(from: DateComponents(minute: -minutes)) }
        if minutes < 24 * 60 {
            let hours = minutes / 60, rest = minutes % 60
            if rest == 0 { return words.localizedString(from: DateComponents(hour: -hours)) }
            let span = DateComponentsFormatter()
            span.unitsStyle = .short
            span.allowedUnits = [.hour, .minute]
            var calendar = Calendar.current
            calendar.locale = locale
            span.calendar = calendar
            let length = span.string(from: DateComponents(hour: hours, minute: rest)) ?? ""
            return String(localized: "\(length) ago")
        }
        // A day or more: the largest unit is enough ("3 days ago", "2 wk. ago").
        return words.localizedString(for: date, relativeTo: now)
    }
}

/// `DateFormatting.ago`, kept current while it is on screen: redrawn every
/// half minute, in the language the app is set to.
struct TimeAgo: View {
    let date: Date
    @Environment(\.locale) private var locale

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            Text(verbatim: DateFormatting.ago(date, now: context.date, locale: locale))
        }
    }
}
