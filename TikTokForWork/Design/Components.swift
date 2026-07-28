import SwiftUI

struct PageDots: View {
    let count: Int
    let index: Int

    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<count, id: \.self) { i in
                Capsule()
                    .fill(i == index ? Theme.Colors.textPrimary : Theme.Colors.textTertiary.opacity(0.45))
                    .frame(width: i == index ? 16 : 5, height: 5)
                    .animation(.easeOut(duration: 0.2), value: index)
            }
        }
    }
}

struct PrimaryButton: View {
    let title: String
    var enabled: Bool = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 16, weight: .medium))
                .frame(maxWidth: .infinity)
                .frame(height: 48)
                .background(enabled ? Theme.Colors.textPrimary : Theme.Colors.surfaceRaised)
                .foregroundStyle(enabled ? Theme.Colors.background : Theme.Colors.textTertiary)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
        }
        .disabled(!enabled)
    }
}

struct SecondaryAction: View {
    let title: String
    var tint: Color = Theme.Colors.textSecondary
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 14))
                .foregroundStyle(tint)
                .frame(maxWidth: .infinity)
                .frame(height: 40)
        }
    }
}

struct ComposeBar: View {
    let placeholder: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: "sparkle")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.Colors.textTertiary)
                Text(placeholder)
                    .font(Theme.TypeScale.body)
                    .foregroundStyle(Theme.Colors.textTertiary)
                Spacer()
            }
            .padding(.horizontal, Theme.Spacing.md)
            .frame(height: 48)
            .background(Theme.Colors.surfaceRaised)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
        }
    }
}
