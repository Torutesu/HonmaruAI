// A dialog over the app says aria-modal: what is behind it is out of reach.
// The scrim keeps the mouse out; nothing kept Tab out, so it walked on into
// the sidebar and the composer under the scrim, where Enter pressed buttons
// nobody could see. Tab goes round inside the dialog instead.

/// What Tab can stop on inside a dialog.
export const TAB_STOPS = 'a[href], details > summary:first-of-type, button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/// Where Tab (or Shift+Tab, `back`) goes from `at` among the dialog's
/// `stops`, in the order drawn: the next one, round past either end. From
/// anywhere else — the dialog itself, which takes focus when it opens, or
/// something outside it — Tab starts at the first and Shift+Tab at the
/// last. Null when the dialog has nothing to stop on: focus stays on it.
export function tabWithin<T>(stops: readonly T[], at: T | null | undefined, back: boolean): T | null {
  const n = stops.length
  if (!n) return null
  const i = at == null ? -1 : stops.indexOf(at)
  if (i < 0) return stops[back ? n - 1 : 0]
  return stops[(i + (back ? -1 : 1) + n) % n]
}
