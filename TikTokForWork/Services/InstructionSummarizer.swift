import Foundation

enum InstructionSummarizer {
    static func summarize(
        _ text: String,
        sender: User,
        recipientID: String,
        cardType: CardType
    ) -> (title: String, summary: String, context: String) {
        let cleaned = cleanInstruction(text)
        let recipientName = DemoData.userName(for: recipientID)
        let summary = sentenceCase(trimToLength(cleaned, maxLength: 180))

        let title: String
        switch cardType {
        case .approval: title = "Approval needed"
        case .delegation: title = "Task for \(recipientName)"
        case .revision: title = "Revision requested"
        case .task: title = shortTitle(from: cleaned)
        case .notification: title = "Update for \(recipientName)"
        }

        let context = "routing: \(sender.name) → \(recipientName) · scope: \(shortTitle(from: cleaned))"
        return (title, summary, context)
    }

    private static func cleanInstruction(_ text: String) -> String {
        var value = text.trimmingCharacters(in: .whitespacesAndNewlines)

        let patterns = [
            #"^(please\s+)?(tell|ask|notify|send|ping|remind)\s+(alice|bob|manager)\s+(to\s+)?"#,
            #"^(can you|could you|hey|hi|yo)\s+"#,
            #"^(i need|we need)\s+(alice|bob|manager)\s+to\s+"#
        ]

        for pattern in patterns {
            if let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) {
                let range = NSRange(value.startIndex..., in: value)
                value = regex.stringByReplacingMatches(in: value, range: range, withTemplate: "")
            }
        }

        value = value.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        return value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func shortTitle(from text: String) -> String {
        let words = text.split(separator: " ").prefix(6)
        guard !words.isEmpty else { return "New task" }
        let title = words.joined(separator: " ")
        return sentenceCase(trimToLength(title, maxLength: 48))
    }

    private static func trimToLength(_ text: String, maxLength: Int) -> String {
        guard text.count > maxLength else { return text }
        let index = text.index(text.startIndex, offsetBy: maxLength)
        return String(text[..<index]).trimmingCharacters(in: .whitespacesAndNewlines) + "…"
    }

    private static func sentenceCase(_ text: String) -> String {
        guard let first = text.first else { return text }
        return first.uppercased() + text.dropFirst()
    }
}
