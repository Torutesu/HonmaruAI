import SwiftUI

// Liquid Glass where the system has it (iOS 26), and a material that reads
// the same way where it does not. Built with an SDK older than 26 — the
// compiler check — this is only ever the material, so the project still
// builds on every Xcode the CI runner might pick.

extension View {
    /// Chrome that floats over content — the tab bar, the composer, a
    /// floating button — in a capsule of glass.
    @ViewBuilder
    func glassCapsule(interactive: Bool = false, tint: Color? = nil) -> some View {
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) {
            self.glassEffect(Self.glass(interactive: interactive, tint: tint), in: Capsule())
        } else {
            self.background(.ultraThinMaterial, in: Capsule())
                .overlay(Capsule().stroke(Color.white.opacity(0.18), lineWidth: 0.5))
                .shadow(color: .black.opacity(0.10), radius: 16, y: 6)
        }
        #else
        self.background(.ultraThinMaterial, in: Capsule())
            .overlay(Capsule().stroke(Color.white.opacity(0.18), lineWidth: 0.5))
            .shadow(color: .black.opacity(0.10), radius: 16, y: 6)
        #endif
    }

    /// The same, in a rounded rectangle: a panel, a tray, a banner.
    @ViewBuilder
    func glassPanel(cornerRadius: CGFloat = 20, interactive: Bool = false) -> some View {
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) {
            self.glassEffect(Self.glass(interactive: interactive, tint: nil), in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        } else {
            self.background(.regularMaterial, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous).stroke(Color.white.opacity(0.16), lineWidth: 0.5))
                .shadow(color: .black.opacity(0.08), radius: 14, y: 5)
        }
        #else
        self.background(.regularMaterial, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous).stroke(Color.white.opacity(0.16), lineWidth: 0.5))
            .shadow(color: .black.opacity(0.08), radius: 14, y: 5)
        #endif
    }

    /// A round glass button face.
    @ViewBuilder
    func glassCircle(tint: Color? = nil) -> some View {
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) {
            self.glassEffect(Self.glass(interactive: true, tint: tint), in: Circle())
        } else {
            self.background(tint.map { AnyShapeStyle($0) } ?? AnyShapeStyle(.ultraThinMaterial), in: Circle())
                .shadow(color: .black.opacity(0.12), radius: 10, y: 4)
        }
        #else
        self.background(tint.map { AnyShapeStyle($0) } ?? AnyShapeStyle(.ultraThinMaterial), in: Circle())
            .shadow(color: .black.opacity(0.12), radius: 10, y: 4)
        #endif
    }

    #if compiler(>=6.2)
    @available(iOS 26.0, *)
    private static func glass(interactive: Bool, tint: Color?) -> Glass {
        var g = Glass.regular
        if let tint { g = g.tint(tint) }
        if interactive { g = g.interactive() }
        return g
    }
    #endif
}

/// Glass shapes near one another melt together on iOS 26, as the system's
/// own controls do; elsewhere this is only a stack.
struct GlassGroup<Content: View>: View {
    var spacing: CGFloat = 12
    @ViewBuilder var content: () -> Content
    var body: some View {
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: spacing) { content() }
        } else {
            content()
        }
        #else
        content()
        #endif
    }
}
