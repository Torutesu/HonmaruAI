import Foundation

/// The composer's marks, as the web's format bar sets them: a quote or a
/// list on the line being written (on again takes it off; one mark swaps
/// for another), bold and the rest around the last word — and a new line in
/// a quote or a list carrying its mark on.
enum ChatFormat {
    private static let marks = ["> ", "- ", "• "]

    private static func markOf(_ line: String) -> String? {
        if let m = marks.first(where: { line.hasPrefix($0) }) { return m }
        if let n = ChatRichText.numbered(line) { return "\(n.n). " }
        return nil
    }

    /// The last line of the draft marked, or unmarked when it already was.
    static func toggleLine(_ text: String, mark: String) -> String {
        var lines = text.components(separatedBy: "\n")
        let last = lines.removeLast()
        let current = markOf(last)
        let bare = current.map { String(last.dropFirst($0.count)) } ?? last
        // A bullet typed as "- " is the same bullet the button writes as "• ".
        let bullets: Set<String> = ["- ", "• "]
        let same = current == mark || (bullets.contains(mark) && current.map(bullets.contains) == true)
            || (mark == "1. " && current.map { ChatRichText.numbered($0 + "x") != nil } == true)
        let next = same ? bare : (mark == "1. " ? "1. " : mark) + bare
        return (lines + [next]).joined(separator: "\n")
    }

    /// The last word wrapped in a mark — or a pair to type into, when the
    /// draft ends in a space or is empty.
    static func wrapLast(_ text: String, _ mark: String) -> String {
        guard let last = text.last, !last.isWhitespace else { return text + mark + mark }
        let start = text.lastIndex(where: { $0.isWhitespace }).map { text.index(after: $0) } ?? text.startIndex
        return String(text[..<start]) + mark + String(text[start...]) + mark
    }

    /// When a line break was just typed at the end: the draft with the mark
    /// carried on, or with an empty marked line closed. Nil otherwise.
    static func continued(old: String, new: String) -> String? {
        guard new == old + "\n" else { return nil }
        let line = old.components(separatedBy: "\n").last ?? ""
        guard let mark = markOf(line) else { return nil }
        if line.count == mark.count {
            // An empty marked line: the list ends here.
            return String(old.dropLast(mark.count))
        }
        if let n = ChatRichText.numbered(line) { return new + "\(n.n + 1). " }
        return new + mark
    }
}
