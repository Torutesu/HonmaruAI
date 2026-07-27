import SwiftUI

struct ProcessingOverlay: View {
    let message: String

    var body: some View {
        ZStack {
            Theme.Colors.background.opacity(0.72)
                .ignoresSafeArea()

            VStack(spacing: Theme.Spacing.md) {
                ProgressView()
                    .tint(Theme.Colors.textPrimary)

                Text(message)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
            .padding(Theme.Spacing.lg)
            .background(Theme.Colors.surfaceRaised)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
        .transition(.opacity)
    }
}
