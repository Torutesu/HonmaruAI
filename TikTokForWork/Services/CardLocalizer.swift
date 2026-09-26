import Foundation
import NaturalLanguage

/// Cards in the language this person reads. The relay translates a card for
/// its recipient when it is made; a card that arrived before they changed
/// language — or was written in another — is asked for here, a few at a
/// time, and the relay sends the translated card back over the socket.
@MainActor
enum CardLocalizer {
    private static var asked = Set<String>()

    /// The card's own language, as far as its words show: "ja", "en"…
    nonisolated static func language(of card: DecisionCard) -> String? {
        let text = "\(card.title) \(card.summary)".trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.count >= 4, let found = NLLanguageRecognizer.dominantLanguage(for: text) else { return nil }
        return primary(found.rawValue)
    }

    nonisolated static func primary(_ code: String) -> String {
        String(code.lowercased().split(whereSeparator: { $0 == "-" || $0 == "_" }).first ?? Substring(code))
    }

    /// Ask for the cards that are not in `language` yet. Never throws; a card
    /// that cannot be translated stays in its own words.
    static func request(for cards: [DecisionCard], language: String, orgId: String, base: URL) async {
        let lang = primary(language)
        guard !orgId.isEmpty, let token = SessionStore.sessionToken, !token.isEmpty else { return }
        let needing = cards.filter { card in
            guard card.translation(for: lang) == nil, !asked.contains("\(card.id)|\(lang)") else { return false }
            guard let own = CardLocalizer.language(of: card) else { return false }
            return own != lang
        }.prefix(8)
        for card in needing {
            asked.insert("\(card.id)|\(lang)")
            let path = "cards/\(card.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? card.id)/localize"
            guard let url = URL(string: path, relativeTo: base) else { continue }
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.timeoutInterval = 30
            request.setValue(token, forHTTPHeaderField: "x-session-token")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: ["orgId": orgId, "locale": lang])
            // The translated card comes back over the relay; a refusal (the
            // day's allowance nearly used) simply leaves it as it is.
            if let (_, response) = try? await URLSession.shared.data(for: request),
               (response as? HTTPURLResponse)?.statusCode == 429 { break }
        }
    }
}
