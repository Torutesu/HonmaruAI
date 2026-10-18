// Translations this browser has already been given, kept across reloads and
// remounts (#225): a message translated this morning is still shown
// translated this afternoon — at once, and even when the next request for
// it fails. Each is kept with the words it was made from and the language
// it was made into, so an edit or a change of language asks again for that
// message alone. Per workspace, and cleared with the account on sign-out
// (clearAccountData's 'translations:').

const PREFIX = 'translations:'
const MAX = 800

type Entry = [from: string, text: string, at: number]
const memory = new Map<string, Record<string, Entry>>()

function load(orgId: string): Record<string, Entry> {
  const hit = memory.get(orgId)
  if (hit) return hit
  let kept: Record<string, Entry> = {}
  try {
    const raw = localStorage.getItem(PREFIX + orgId)
    const parsed = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === 'object') kept = parsed
  } catch { /* blocked or unreadable: start empty */ }
  memory.set(orgId, kept)
  return kept
}

/// A short fingerprint of a message's words — the Worker's sourceHash.
function wordsHash(text: string): string {
  let h = 0x811c9dc5
  for (const c of String(text || '')) {
    h ^= c.codePointAt(0) || 0
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16)
}

/// Where one version of a message's translation is kept: by the message,
/// the language and the words it was made from. One version never takes
/// another's place — a slow answer for words since edited cannot put out
/// the translation of the words as they are now.
export function translationKey(id: string, lang: string, from: string): string {
  return `${id}:${lang}:${wordsHash(from)}`
}

/// The kept translation of a message, when it was made from these very
/// words into this language. (Kept before versions were, under the message
/// and language alone: still read.)
export function keptTranslation(orgId: string, id: string, lang: string, body: string): string | null {
  const all = load(orgId)
  for (const e of [all[translationKey(id, lang, body)], all[`${id}:${lang}`]]) {
    if (Array.isArray(e) && e[0] === body && typeof e[1] === 'string') return e[1]
  }
  return null
}

export function keepTranslations(orgId: string, lang: string, items: { id: string; from: string; text: string }[], now = Date.now()): void {
  if (!items.length) return
  const all = { ...load(orgId) }
  for (const i of items) all[translationKey(i.id, lang, i.from)] = [i.from, i.text, now]
  // Newest kept, capped: a long history is not worth a quota error.
  const keys = Object.keys(all)
  const trimmed = keys.length > MAX
    ? Object.fromEntries(Object.entries(all).sort((a, b) => b[1][2] - a[1][2]).slice(0, MAX))
    : all
  memory.set(orgId, trimmed)
  try { localStorage.setItem(PREFIX + orgId, JSON.stringify(trimmed)) } catch { /* full or blocked: kept for this page */ }
}

/// The messages to ask about, in requests of at most `size`: every one of
/// them, however long the history — a request is bounded, the work is not.
export function translationBatches<T>(list: T[], size = 60): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

export function forgetTranslations(): void {
  memory.clear()
}

/// Why a translation could not be had — enough to tell a person what to do
/// about it, nothing the server or the provider said.
export type TranslateFailure = 'offline' | 'auth' | 'rate_limit' | 'server' | 'provider' | 'quota'

/// The failure a response stands for: no response at all, its status, or
/// the reason the Worker gave for one message ("provider", "quota", …).
export function failureOf(status: number | null, reason?: string | null): TranslateFailure | null {
  if (reason) {
    if (reason === 'no_provider') return null
    if (reason === 'quota') return 'quota'
    return 'provider'
  }
  if (status === null) return 'offline'
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate_limit'
  return 'server'
}

export const FAILURE_LABEL: Record<TranslateFailure, string> = {
  offline: 'No connection',
  auth: 'Sign in again',
  rate_limit: 'Too many requests',
  server: 'Server error',
  provider: 'Translator error',
  quota: 'AI allowance used up',
}
