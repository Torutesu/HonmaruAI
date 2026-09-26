import AuthenticationServices
import Foundation

/// Signing in through the company's identity provider.
///
/// docs/sso-and-domain-join.md §6. The Worker says, from the address, whether
/// its company signs in this way; the provider's page opens in a browser
/// sheet; the Worker hands back a one-time code (never the session itself),
/// and this trades it for the session.
@MainActor
enum SSOService {
    struct Offer: Equatable {
        let orgId: String
        let providerName: String
        let workspaceName: String
        let enforced: Bool
    }

    enum Failure: LocalizedError {
        case cancelled
        case refused(String)
        case unreachable
        var errorDescription: String? {
            switch self {
            case .cancelled: String(localized: "Sign-in was cancelled.")
            case .refused(let text): text
            case .unreachable: String(localized: "Could not reach the server. Check your connection and try again.")
            }
        }
    }

    private static let context = WebAuthContextProvider()
    private static var running: ASWebAuthenticationSession?

    private static var base: URL? { BackendURL.httpBase(from: AppConfig.relayURL) }

    /// Whether this address's company signs in with SSO here.
    static func discover(email: String) async -> Offer? {
        guard let base else { return nil }
        var request = URLRequest(url: base.appendingPathComponent("auth/discover"))
        request.httpMethod = "POST"
        request.timeoutInterval = 10
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["email": EmailAuthService.normalizedEmail(email)])
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return decodeOffer(data)
    }

    static func decodeOffer(_ data: Data) -> Offer? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let sso = json["sso"] as? [String: Any],
              let orgId = sso["orgId"] as? String else { return nil }
        return Offer(
            orgId: orgId,
            providerName: sso["providerName"] as? String ?? "SSO",
            workspaceName: sso["name"] as? String ?? "",
            enforced: sso["enforced"] as? Bool ?? false
        )
    }

    /// The code in the Worker's redirect back to the app, or why there is none.
    static func handoff(from url: URL) throws -> String {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        if let error = items.first(where: { $0.name == "error" })?.value { throw Failure.refused(error) }
        guard let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty else { throw Failure.refused(String(localized: "That sign-in did not finish. Try again.")) }
        return code
    }

    /// The provider's page in a browser sheet, then the session.
    static func signIn(orgId: String, email: String) async throws -> EmailAuthService.Session {
        guard let base, var components = URLComponents(url: base.appendingPathComponent("sso/start"), resolvingAgainstBaseURL: false) else { throw Failure.unreachable }
        components.queryItems = [
            URLQueryItem(name: "orgId", value: orgId),
            URLQueryItem(name: "client", value: "ios"),
            URLQueryItem(name: "email", value: EmailAuthService.normalizedEmail(email)),
        ]
        guard let start = components.url else { throw Failure.unreachable }
        let callback: URL = try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: start, callbackURLScheme: "tiktokforwork") { url, error in
                if let error {
                    let ns = error as NSError
                    if ns.domain == ASWebAuthenticationSessionErrorDomain, ns.code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
                        continuation.resume(throwing: Failure.cancelled)
                    } else {
                        continuation.resume(throwing: Failure.unreachable)
                    }
                    return
                }
                guard let url else { continuation.resume(throwing: Failure.unreachable); return }
                continuation.resume(returning: url)
            }
            session.presentationContextProvider = context
            session.prefersEphemeralWebBrowserSession = false
            running = session
            session.start()
        }
        running = nil
        let code = try handoff(from: callback)
        var request = URLRequest(url: base.appendingPathComponent("sso/exchange"))
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["code": code, "client": "ios"])
        let (data, response) = try await URLSession.shared.data(for: request)
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw Failure.refused(json["message"] as? String ?? String(localized: "That sign-in did not finish. Try again."))
        }
        return try EmailAuthService.decodeSession(json)
    }
}
