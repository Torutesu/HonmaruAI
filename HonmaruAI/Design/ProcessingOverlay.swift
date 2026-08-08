import SwiftUI

struct ProcessingOverlay: View {
    let message: String

    var body: some View {
        ZStack {
            Color.black.opacity(0.55)
                .ignoresSafeArea()

            HStack(spacing: 12) {
                ProgressView()
                    .tint(Theme.Colors.textPrimary)
                Text(message)
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 14)
            .background(Theme.Colors.surfaceRaised)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
        }
        .transition(.opacity)
    }
}

struct DraftingBanner: View {
    var body: some View {
        HStack(spacing: 10) {
            ProgressView()
                .controlSize(.small)
                .tint(Theme.Colors.accent)
            Text("Drafting decision card…")
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textSecondary)
            Spacer()
        }
        .padding(.horizontal, Theme.Spacing.screen)
        .padding(.vertical, Theme.Spacing.sm)
        .background(Theme.Colors.surfaceRaised.opacity(0.95))
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Theme.Colors.textTertiary.opacity(0.2))
                .frame(height: 0.5)
        }
        .transition(.move(edge: .top).combined(with: .opacity))
    }
}
