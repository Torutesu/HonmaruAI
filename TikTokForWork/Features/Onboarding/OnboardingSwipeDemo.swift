import SwiftUI

/// Interactive tutorial step: a real decision card the user must swipe to
/// continue. Teaches the core gesture by doing it, not by reading about it.
struct OnboardingSwipeDemo: View {
    let onFinished: () -> Void

    @State private var dragOffset: CGFloat = 0
    @State private var resolution: Resolution?

    private let swipeThreshold: CGFloat = 96

    private enum Resolution {
        case approved
        case declined

        var label: String {
            switch self {
            case .approved: String(localized: "Approved — that's the whole job")
            case .declined: String(localized: "Declined — also one swipe")
            }
        }

        var color: Color {
            switch self {
            case .approved: Theme.Colors.approve
            case .declined: Theme.Colors.reject
            }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                Text("Try it")
                    .font(.system(size: 28, weight: .medium))
                    .foregroundStyle(Theme.Colors.textPrimary)
                Text("This is a Decision Card. Swipe right to approve, left to decline.")
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .lineSpacing(4)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.top, Theme.Spacing.xl)

            Spacer()

            ZStack {
                swipeHints

                demoCard
                    .offset(x: dragOffset)
                    .rotationEffect(.degrees(Double(dragOffset) / 40))
                    .gesture(swipeGesture)
                    .opacity(resolution == nil ? 1 : 0)

                if let resolution {
                    VStack(spacing: Theme.Spacing.sm) {
                        Image(systemName: resolution == .approved ? "checkmark.circle" : "xmark.circle")
                            .font(.system(size: 32, weight: .regular))
                            .foregroundStyle(resolution.color)
                        Text(resolution.label)
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(Theme.Colors.textPrimary)
                    }
                    .transition(.opacity)
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 320)

            Spacer()

            Text(resolution == nil
                 ? String(localized: "In the real feed this records the decision — and syncs it to GitHub.")
                 : String(localized: "Cards you clear move on. The next decision scrolls up."))
                .font(Theme.TypeScale.micro)
                .foregroundStyle(Theme.Colors.textTertiary)
                .frame(maxWidth: .infinity)
                .padding(.bottom, Theme.Spacing.xl + Theme.Spacing.xl)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(.easeOut(duration: 0.2), value: resolution != nil)
    }

    private var demoCard: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            HStack(alignment: .center, spacing: Theme.Spacing.sm) {
                Text("APPROVAL")
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .tracking(0.8)
                    .foregroundStyle(Theme.Colors.approve)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Theme.Colors.approve.opacity(0.10))
                    .clipShape(Capsule())

                HStack(spacing: 4) {
                    Circle()
                        .fill(Theme.Colors.reject)
                        .frame(width: 5, height: 5)
                    Text("URGENT")
                        .font(.system(size: 10, weight: .medium, design: .monospaced))
                        .tracking(0.7)
                        .foregroundStyle(Theme.Colors.reject)
                }

                Spacer()
                Text("now")
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(Theme.Colors.textTertiary)
            }

            Text("Approve the Friday release?")
                .font(.system(size: 22, weight: .medium))
                .foregroundStyle(Theme.Colors.textPrimary)

            Text("QA passed on staging. Your AI batched 6 merged PRs into one release and checked the deploy window.")
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textSecondary)
                .lineSpacing(4)
                .fixedSize(horizontal: false, vertical: true)

            HStack(alignment: .top, spacing: 7) {
                Image(systemName: "sparkle")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.Colors.accent)
                Text("Dana's AI → Your AI · You hold release approval")
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textPrimary)
            }
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, Theme.Spacing.sm)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.Colors.accent.opacity(0.07))
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.card))
        }
        .padding(Theme.Spacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Colors.background)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.card))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.Radius.card)
                .strokeBorder(Theme.Colors.border, lineWidth: 1)
        }
        .shadow(color: Color.black.opacity(0.06), radius: 6, x: 0, y: 2)
    }

    private var swipeHints: some View {
        HStack {
            if dragOffset > 24 {
                hintLabel("Approve", color: Theme.Colors.approve)
                Spacer()
            } else if dragOffset < -24 {
                Spacer()
                hintLabel("Decline", color: Theme.Colors.reject)
            }
        }
        .opacity(min(abs(dragOffset) / swipeThreshold, 1))
        .allowsHitTesting(false)
    }

    private func hintLabel(_ title: LocalizedStringKey, color: Color) -> some View {
        Text(title)
            .font(.system(size: 15, weight: .medium))
            .foregroundStyle(color)
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, Theme.Spacing.sm)
            .background(color.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }

    private var swipeGesture: some Gesture {
        DragGesture(minimumDistance: 10, coordinateSpace: .local)
            .onChanged { value in
                guard resolution == nil else { return }
                let horizontal = value.translation.width
                let vertical = value.translation.height
                guard abs(horizontal) > abs(vertical) else { return }
                dragOffset = horizontal
            }
            .onEnded { value in
                guard resolution == nil else { return }
                let horizontal = value.translation.width
                let vertical = value.translation.height
                guard abs(horizontal) > abs(vertical) else {
                    withAnimation(.easeOut(duration: 0.18)) { dragOffset = 0 }
                    return
                }

                if horizontal > swipeThreshold {
                    resolve(.approved, direction: 1)
                } else if horizontal < -swipeThreshold {
                    resolve(.declined, direction: -1)
                } else {
                    withAnimation(.easeOut(duration: 0.18)) {
                        dragOffset = 0
                    }
                }
            }
    }

    private func resolve(_ outcome: Resolution, direction: CGFloat) {
        Haptics.success()
        withAnimation(.easeOut(duration: 0.25)) {
            dragOffset = direction * 600
        }
        withAnimation(.easeOut(duration: 0.2).delay(0.15)) {
            resolution = outcome
        }

        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(1100))
            onFinished()
        }
    }
}

#Preview {
    OnboardingSwipeDemo {}
        .appBackground()
}
