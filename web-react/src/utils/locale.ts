// The language this person reads, for the page and for the Worker.
//
// A choice made under ⋯ wins; otherwise the browser's language. Stored per
// browser, mirrored to the Worker (PUT /me) so every notification — here, on
// the phone, by email — is written in it.

export const SUPPORTED = ['en', 'ja'] as const

export function primary(tag: string | undefined | null): string {
  return (tag || 'en').toLowerCase().split(/[-_]/)[0]
}

export function getLocale(): string {
  try {
    const chosen = localStorage.getItem('locale')
    if (chosen) return chosen
  } catch { /* fall through */ }
  return primary(typeof navigator !== 'undefined' ? navigator.language : 'en')
}

export function setLocale(code: string | null): void {
  try {
    if (code) localStorage.setItem('locale', code)
    else localStorage.removeItem('locale')
  } catch { /* a preference, not a record */ }
}
