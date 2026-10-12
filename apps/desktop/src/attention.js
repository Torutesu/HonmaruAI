// Whether anybody is at this window.
//
// The page decides what is read, and whether a message is for the phone,
// by whether someone is looking at it. In a browser `document.visibilityState`
// answers half of that. In this app it cannot: the window runs with
// `backgroundThrottling: false` so the socket keeps going in the tray, and
// then Chromium reports "visible" for a window that is minimized, hidden or
// behind a locked screen. A window left in front at the end of the day read
// every message that came in overnight, so the phone was never told about
// them, and the desktop showed nothing either — it thought someone was there.
//
// So the main process, which knows, says: hidden, minimized, behind a locked
// screen or a sleeping machine, or nobody has touched the keyboard or mouse
// for a while.

/// Seconds without input after which nobody is counted as at the screen.
export const IDLE_AFTER_SECONDS = 120

/// `state`: { visible, minimized, locked, suspended, idleSeconds }.
export function isAway(state, idleAfter = IDLE_AFTER_SECONDS) {
  if (!state) return true
  if (!state.visible || state.minimized) return true
  if (state.locked || state.suspended) return true
  return Number(state.idleSeconds) >= idleAfter
}
