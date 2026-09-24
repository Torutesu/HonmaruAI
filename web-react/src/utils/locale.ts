// The language this person reads, for the page and for the Worker.
//
// A choice made under ⋯ wins; then the language of the page that linked here
// (the landing page adds ?lang=); otherwise the browser's language. Stored per
// browser, mirrored to the Worker (PUT /me) so every notification — here, on
// the phone, by email — is written in it.

export const SUPPORTED = ['en', 'ja', 'es', 'fr', 'de'] as const

export function primary(tag: string | undefined | null): string {
  return (tag || 'en').toLowerCase().split(/[-_]/)[0]
}

export function getLocale(): string {
  try {
    const chosen = localStorage.getItem('locale')
    if (chosen) return chosen
  } catch { /* fall through */ }
  return linkedLocale() || primary(typeof navigator !== 'undefined' ? navigator.language : 'en')
}

/// The language the visitor was reading on the page that sent them here, from
/// ?lang=. It is not saved: a choice made in the app still wins next time.
export function linkedLocale(): string | null {
  if (typeof location === 'undefined') return null
  const asked = new URLSearchParams(location.search).get('lang')
  if (!asked) return null
  const code = primary(asked)
  return (SUPPORTED as readonly string[]).includes(code) ? code : null
}

export function setLocale(code: string | null): void {
  try {
    if (code) localStorage.setItem('locale', code)
    else localStorage.removeItem('locale')
  } catch { /* a preference, not a record */ }
}

/// The languages a notification can be written in, as their own names. Kept
/// beside SUPPORTED so adding a language is adding one line in one place.
export const LOCALE_NAMES: Record<string, string> = {
  en: 'English',
  ja: '日本語',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
}
