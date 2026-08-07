import Foundation
import SwiftUI

enum WorkTool: String, CaseIterable, Identifiable, Codable {
    case slack
    case github
    case notion
    case gmail
    case calendar

    var id: String { rawValue }

    var label: String {
        switch self {
        case .slack: "Slack"
        case .github: "GitHub"
        case .notion: "Notion"
        case .gmail: "Gmail"
        case .calendar: "Calendar"
        }
    }

    var icon: String {
        switch self {
        case .slack: "number"
        case .github: "chevron.left.forwardslash.chevron.right"
        case .notion: "doc.text"
        case .gmail: "envelope"
        case .calendar: "calendar"
        }
    }

    var blurb: String {
        switch self {
        case .slack: "Your AI posts decisions and summaries to the right channels."
        case .github: "Decisions sync to Issues so engineers see them where they work."
        case .notion: "Finalized decisions are archived to your team's docs."
        case .gmail: "Your AI drafts and sends follow-up mail on your behalf."
        case .calendar: "Deadlines and review slots land on your calendar."
        }
    }

    var capabilities: [String] {
        switch self {
        case .slack: ["Post decision summaries", "Notify affected channels", "Read team activity for context"]
        case .github: ["Create and update Issues", "Track decision status", "Link cards to repository activity"]
        case .notion: ["Archive finalized decisions", "Keep a searchable decision log", "Reference docs for context"]
        case .gmail: ["Send decision follow-ups", "Read threads for context", "Draft replies for review"]
        case .calendar: ["Schedule review slots", "Track decision deadlines", "Respect quiet hours"]
        }
    }

    /// GitHub is a live integration; everything else is simulated in the MVP.
    var isSimulated: Bool { self != .github }
}

enum AppLanguage: String, CaseIterable, Identifiable {
    case english
    case japanese

    var id: String { rawValue }

    var label: String {
        switch self {
        case .english: "English"
        case .japanese: "日本語"
        }
    }
}

enum AITone: String, CaseIterable, Identifiable {
    case concise
    case neutral
    case detailed

    var id: String { rawValue }

    var label: String {
        switch self {
        case .concise: "Concise"
        case .neutral: "Neutral"
        case .detailed: "Detailed"
        }
    }
}

enum AIAutonomy: String, CaseIterable, Identifiable {
    case suggest
    case draft
    case act

    var id: String { rawValue }

    var label: String {
        switch self {
        case .suggest: "Suggest"
        case .draft: "Draft"
        case .act: "Act"
        }
    }

    var detail: String {
        switch self {
        case .suggest: "Your AI proposes actions and waits for you"
        case .draft: "Your AI drafts cards, you review before sending"
        case .act: "Your AI executes approved actions immediately"
        }
    }
}

@MainActor
final class AppPreferences: ObservableObject {
    private enum Keys {
        static let hasSeenIntro = "prefs.hasSeenIntro"
        static let connectedTools = "prefs.connectedTools"
        static let language = "prefs.language"
        static let tone = "prefs.tone"
        static let autonomy = "prefs.autonomy"
        static let quietHours = "prefs.quietHours"
    }

    private let defaults = UserDefaults.standard

    @Published var hasSeenIntro: Bool {
        didSet { defaults.set(hasSeenIntro, forKey: Keys.hasSeenIntro) }
    }

    @Published var connectedTools: Set<WorkTool> {
        didSet { defaults.set(connectedTools.map(\.rawValue).sorted(), forKey: Keys.connectedTools) }
    }

    @Published var language: AppLanguage {
        didSet { defaults.set(language.rawValue, forKey: Keys.language) }
    }

    @Published var tone: AITone {
        didSet { defaults.set(tone.rawValue, forKey: Keys.tone) }
    }

    @Published var autonomy: AIAutonomy {
        didSet { defaults.set(autonomy.rawValue, forKey: Keys.autonomy) }
    }

    @Published var quietHours: Bool {
        didSet { defaults.set(quietHours, forKey: Keys.quietHours) }
    }

    init() {
        hasSeenIntro = defaults.bool(forKey: Keys.hasSeenIntro)
        let rawTools = defaults.stringArray(forKey: Keys.connectedTools) ?? []
        connectedTools = Set(rawTools.compactMap(WorkTool.init(rawValue:)))
        language = defaults.string(forKey: Keys.language).flatMap(AppLanguage.init(rawValue:)) ?? .english
        tone = defaults.string(forKey: Keys.tone).flatMap(AITone.init(rawValue:)) ?? .concise
        autonomy = defaults.string(forKey: Keys.autonomy).flatMap(AIAutonomy.init(rawValue:)) ?? .draft
        quietHours = defaults.bool(forKey: Keys.quietHours)
    }

    func toggle(_ tool: WorkTool) {
        if connectedTools.contains(tool) {
            connectedTools.remove(tool)
        } else {
            connectedTools.insert(tool)
        }
    }

    func isConnected(_ tool: WorkTool, githubService: GitHubService) -> Bool {
        if tool == .github {
            return githubService.isConnected || githubService.hasToken
        }
        return connectedTools.contains(tool)
    }
}
