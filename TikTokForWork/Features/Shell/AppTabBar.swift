import SwiftUI

enum AppTab: CaseIterable, Hashable {
    case inbox, sent, completed, workspace
    var title: String {
        switch self {
        case .inbox: String(localized: "Inbox")
        case .sent: String(localized: "Sent")
        case .completed: String(localized: "Completed")
        case .workspace: String(localized: "Workspace")
        }
    }
    var symbol: String {
        switch self {
        case .inbox: "tray"
        case .sent: "paperplane"
        case .completed: "checkmark.circle"
        case .workspace: "square.grid.2x2"
        }
    }
}

struct AppTabBar: View {
    @Binding var selection: AppTab
    var pendingCount = 0
    var body: some View {
        HStack(spacing: 0) {
            ForEach(AppTab.allCases, id: \.self) { tab in
                Button { selection = tab } label: {
                    VStack(spacing: 5) {
                        Image(systemName: selection == tab ? tab.symbol + ".fill" : tab.symbol)
                            .font(.system(size: 21, weight: .regular))
                            .frame(width: 40, height: 25)
                            .overlay(alignment: .topTrailing) {
                                if tab == .inbox && pendingCount > 0 {
                                    Text(pendingCount > 99 ? "99+" : "\(pendingCount)")
                                        .font(.system(size: 10, weight: .semibold)).foregroundStyle(.white)
                                        .padding(.horizontal, 4).frame(minWidth: 16, minHeight: 16)
                                        .background(Theme.Colors.accent, in: Capsule()).offset(x: 8, y: -5)
                                }
                            }
                        Text(tab.title).font(.caption2.weight(selection == tab ? .semibold : .regular))
                    }
                    .foregroundStyle(selection == tab ? Theme.Colors.accent : Theme.Colors.textSecondary)
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityAddTraits(selection == tab ? .isSelected : [])
            }
        }
        .padding(.top, 10).padding(.bottom, 4)
        .background(Theme.Colors.background.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) { Divider() }
    }
}
