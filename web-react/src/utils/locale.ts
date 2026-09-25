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

/// Languages a person can read their cards and notifications in — every one
/// the Worker can write, which is far more than the five the screens are
/// translated into. Cards are translated by the model; notification words
/// by hand for SUPPORTED and by the model, once, for the rest.
export const READER_LANGUAGES = [
  'en', 'ja', 'es', 'fr', 'de', 'zh', 'ko', 'pt', 'it', 'nl', 'ru', 'uk', 'pl', 'cs', 'sv', 'da', 'no', 'fi',
  'tr', 'el', 'he', 'ar', 'fa', 'ur', 'hi', 'bn', 'ta', 'te', 'mr', 'th', 'vi', 'id', 'ms', 'tl', 'sw',
  'ro', 'hu', 'bg', 'sr', 'hr', 'sk', 'ca', 'my', 'km', 'ne', 'si', 'am',
] as const

/// A language by its own name ("Tiếng Việt" for vi), for a picker a person
/// reads in that language. Falls back to the code where the browser does not know it.
export function languageLabel(code: string): string {
  if (LOCALE_NAMES[code]) return LOCALE_NAMES[code]
  try {
    const name = new Intl.DisplayNames([code], { type: 'language' }).of(code)
    if (name && name !== code) return name.charAt(0).toLocaleUpperCase(code) + name.slice(1)
  } catch { /* an old browser */ }
  return code
}

/// Whether `code` names a language at all, as far as this browser knows.
export function isLanguage(code: string): boolean {
  if ((READER_LANGUAGES as readonly string[]).includes(code)) return true
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' }).of(code)
    return Boolean(name) && name !== code
  } catch { return false }
}

/// The choices for "the language you read": the screens' languages first,
/// then the rest by name, and the current one even when it is neither.
export function readerLanguageOptions(current?: string): Array<{ code: string; label: string; screens: boolean }> {
  const codes = [...READER_LANGUAGES] as string[]
  const now = primary(current)
  if (current && !codes.includes(now) && isLanguage(now)) codes.push(now)
  const screens = new Set<string>(SUPPORTED)
  const rest = codes.filter((c) => !screens.has(c)).map((code) => ({ code, label: languageLabel(code), screens: false }))
    .sort((a, b) => a.label.localeCompare(b.label))
  return [...SUPPORTED.map((code) => ({ code, label: languageLabel(code), screens: true })), ...rest]
}

/// The language to start someone in: the page that linked here, then the
/// browser's, when it names one; English otherwise.
export function browserLanguage(): string {
  const linked = linkedLocale()
  if (linked) return linked
  const code = primary(typeof navigator !== 'undefined' ? navigator.language : 'en')
  return isLanguage(code) ? code : 'en'
}
