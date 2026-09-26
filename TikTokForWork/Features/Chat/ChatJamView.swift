import SwiftUI
import WebKit

// A Jam from the phone: the same call the web runs — voice, video, screen,
// reactions, the live transcript — in a web view that is handed this
// device's session. One call implementation for every screen, and a phone
// on it hears and is heard like anyone at a laptop.
//
// The view only ever shows the web app's own origin: its session is written
// there and nowhere else, and any link that would leave opens in Safari.

enum ChatJamLink {
    /// Where the web app is, as the Worker says (`/health` → `webUrl`).
    static func webURL(base: URL) async -> URL? {
        struct Health: Decodable { let webUrl: String? }
        guard let url = URL(string: "/health", relativeTo: base),
              let fetched = try? await URLSession.shared.data(from: url),
              let health = try? JSONDecoder().decode(Health.self, from: fetched.0),
              let web = health.webUrl, let out = URL(string: web), out.scheme == "https" || out.host == "127.0.0.1" || out.host == "localhost"
        else { return nil }
        return out
    }

    /// `#/jam/<view>` on the web app: open the conversation and join its Jam.
    static func jamURL(web: URL, view: String) -> URL? {
        let encoded = view.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_.:|"))) ?? view
        return URL(string: "\(web.absoluteString)/#/jam/\(encoded)")
    }
}

struct ChatJamSheet: View {
    let view: String
    let title: String
    let base: URL?
    let orgId: String?
    @Environment(\.dismiss) private var dismiss
    @State private var target: URL?
    @State private var failed = false

    var body: some View {
        NavigationStack {
            Group {
                if let target, let origin = target.originString {
                    ChatJamWebView(url: target, origin: origin, session: session) { dismiss() }
                        .ignoresSafeArea(edges: .bottom)
                } else if failed {
                    ContentUnavailableView("The Jam could not open", systemImage: "headphones", description: Text("Check your connection and try again."))
                } else {
                    ProgressView()
                }
            }
            .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }
        .task {
            guard let base, let web = await ChatJamLink.webURL(base: base), let url = ChatJamLink.jamURL(web: web, view: view) else { failed = true; return }
            target = url
        }
    }

    /// What the web app reads from its storage to open signed in: the same
    /// session, workspace and API as this app.
    private var session: [String: String] {
        var out: [String: String] = ["mode": "classic", "userId": "ios"]
        if let token = SessionStore.sessionToken { out["sessionToken"] = token }
        if let orgId { out["orgId"] = orgId }
        if let base, let host = base.host { out["host"] = base.port.map { "\(host):\($0)" } ?? host }
        return out
    }
}

private extension URL {
    var originString: String? {
        guard let scheme, let host else { return nil }
        return port.map { "\(scheme)://\(host):\($0)" } ?? "\(scheme)://\(host)"
    }
}

struct ChatJamWebView: UIViewRepresentable {
    let url: URL
    let origin: String
    let session: [String: String]
    let onLeft: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(origin: origin, onLeft: onLeft) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        let content = WKUserContentController()
        // Written before the page's own script runs, and only on the web
        // app's origin — never on a page a link might lead to.
        if let json = try? JSONSerialization.data(withJSONObject: session), let values = String(data: json, encoding: .utf8),
           let originJSON = try? JSONSerialization.data(withJSONObject: [origin]), let originList = String(data: originJSON, encoding: .utf8) {
            let script = """
            (function () {
              if (!\(originList).includes(location.origin)) return;
              var v = \(values);
              try { Object.keys(v).forEach(function (k) { localStorage.setItem(k, v[k]); }); } catch (e) {}
            })();
            """
            content.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        content.add(context.coordinator, name: "honmaruJam")
        config.userContentController = content
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.isOpaque = false
        web.load(URLRequest(url: url))
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        // Closing the sheet ends this phone's part in the call.
        uiView.configuration.userContentController.removeScriptMessageHandler(forName: "honmaruJam")
        uiView.stopLoading()
        uiView.loadHTMLString("", baseURL: nil)
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        let origin: String
        let onLeft: () -> Void
        init(origin: String, onLeft: @escaping () -> Void) { self.origin = origin; self.onLeft = onLeft }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.host == URL(string: origin)?.host,
                  let body = message.body as? [String: Any], body["type"] as? String == "left" else { return }
            DispatchQueue.main.async { self.onLeft() }
        }

        // The web app's own pages stay here; anything else opens in Safari.
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
            let home = URL(string: origin)
            if url.scheme == "about" || (url.scheme == home?.scheme && url.host == home?.host && url.port == home?.port) {
                decisionHandler(.allow); return
            }
            decisionHandler(.cancel)
            if url.scheme == "https" || url.scheme == "http" { UIApplication.shared.open(url) }
        }

        // The microphone and camera, for the call on the web app's own
        // origin; iOS still asks the person once for the app itself.
        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            decisionHandler(origin.host == URL(string: self.origin)?.host ? .grant : .deny)
        }
    }
}
