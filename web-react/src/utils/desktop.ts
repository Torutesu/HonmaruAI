// The desktop app (apps/desktop) loads this same web app in its own window,
// with a small bridge on `window.honmaruDesktop` (its preload.cjs). Inside it
// there is no push service — Electron's Chromium has PushManager but nowhere
// to register — and the tray keeps the socket open instead, so decisions
// arrive as the page's own notifications. And a window hidden in the tray
// does not come forward on `window.focus()`: the bridge's `show()` does that.

export interface DesktopBridge {
  isDesktop: true
  platform: string
  show: () => void
  openNotificationSettings?: () => void
  /// Nobody at the window: hidden, minimized, a locked screen or a sleeping
  /// machine, or no input for a while (apps/desktop/src/attention.js). The
  /// page's visibilityState cannot say so in the desktop app.
  away?: () => boolean
  /// The shell answers getDisplayMedia() with a picker of screens and
  /// windows (apps/desktop/src/capture.js). One built before it refuses it.
  screenShare?: boolean
}

/// The bridge, when this page is running in the desktop app.
export function desktopApp(w: { honmaruDesktop?: unknown } | undefined = typeof window !== 'undefined' ? window as unknown as { honmaruDesktop?: unknown } : undefined): DesktopBridge | null {
  const b = w?.honmaruDesktop as Partial<DesktopBridge> | undefined
  return b && b.isDesktop === true && typeof b.show === 'function' ? b as DesktopBridge : null
}

/// Whether the page is in front of somebody: showing, and — in the desktop
/// app, where a hidden or locked window still reports "visible" — with
/// somebody at it. Everything that asks "is anyone here" asks this.
export function pageShowing(doc: { visibilityState: string } | undefined = typeof document !== 'undefined' ? document : undefined): boolean {
  if (!doc || doc.visibilityState !== 'visible') return false
  const desktop = desktopApp()
  try { return !(desktop?.away?.() === true) } catch { return true }
}

/// Bring this window forward: the desktop app's own window out of the tray,
/// or the browser tab.
export function bringForward(): void {
  const desktop = desktopApp()
  if (desktop) {
    try { desktop.show() } catch { /* the window is already in front */ }
    return
  }
  try { window.focus() } catch { /* not ours to focus */ }
}
