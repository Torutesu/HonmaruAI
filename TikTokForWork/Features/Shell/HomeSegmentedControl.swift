import SwiftUI

/// Which surface the Home tab is showing.
///
/// Cards is the product: one decision at a time. Classic is the deliberate
/// "old way" surface, kept so the difference is visible side by side.
enum HomeSurface: Hashable {
    case cards
    case classic
}

/// `#eeeeee` track with a white raised pill for the selected side, per the
/// design system's segmented spec. The count rides in the selected pill the way
/// an unread badge would.
struct HomeSegmentedControl: View {
    @Binding var selection: HomeSurface
    let openCount: Int

    var body: some View {
        HStack(spacing: 0) {
            segment(.cards, title: "カード")
            segment(.classic, title: "クラシック")
        }
        .padding(3)
        .background(Theme.Colors.surfaceRaised)
        .clipShape(Capsule())
        .animation(.easeOut(duration: 0.15), value: selection)
    }

    private func segment(_ surface: HomeSurface, title: LocalizedStringKey) -> some View {
        let isSelected = selection == surface

        return Button {
            selection = surface
        } label: {
            HStack(spacing: 5) {
                Text(title)
                    .font(.system(size: 13, weight: isSelected ? .semibold : .regular))
                    .foregroundStyle(isSelected ? Theme.Colors.textPrimary : Theme.Colors.textSecondary)

                if openCount > 0 {
                    Text("\(openCount)")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Theme.Colors.background)
                        .frame(minWidth: 15, minHeight: 15)
                        .background(Theme.Colors.textPrimary)
                        .clipShape(Circle())
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background {
                if isSelected {
                    Capsule().fill(Theme.Colors.background)
                }
            }
        }
        .buttonStyle(.plain)
    }
}

#Preview {
    VStack(spacing: 20) {
        HomeSegmentedControl(selection: .constant(.cards), openCount: 3)
        HomeSegmentedControl(selection: .constant(.classic), openCount: 0)
    }
    .padding()
    .background(Theme.Colors.background)
}
