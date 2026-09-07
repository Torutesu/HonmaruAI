import Foundation

/// The person's profile on the Worker — today, one thing that matters: the
/// language their notifications are written in.
///
/// A push, a web push or an email is composed on the server, in whatever
/// language the server believes this person reads. The app is the authority
/// on that: the language toggle under **You** is the one explicit choice the
/// person makes, and it is mirrored here so a decision routed to them from a
/// Japanese teammate arrives on their lock screen in English — or the other
/// way round.
enum ProfileService {
    /// Tell the Worker what language this person reads. Never throws: a failure
    /// leaves the server on the language it seeded from the device on sign-in,
    /// and the next toggle, or the next launch, sends it again.
    static func setLocale(_ code: String, backendBaseURL: URL) async {
        guard let token = SessionStore.sessionToken, !token.isEmpty,
              let url = URL(string: "me", relativeTo: backendBaseURL) else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.timeoutInterval = 15
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["locale": code])
        _ = try? await URLSession.shared.data(for: request)
    }
}
