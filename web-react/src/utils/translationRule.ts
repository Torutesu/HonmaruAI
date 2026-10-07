// Whether a message is worth translating for this reader — the same rule
// as the Worker's (worker/src/translate.js), so the browser does not ask
// for, or say "Translating…" about, what the Worker leaves as it is (#220).

const LATIN_READERS = new Set(['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'sv', 'da', 'no', 'nb', 'fi', 'pl', 'cs', 'ro', 'hu', 'tr', 'id', 'ms', 'vi', 'tl', 'sw'])

export function wantsTranslation(lang: string | null | undefined, reader: string, body = ''): boolean {
  const to = String(reader || 'en').slice(0, 2).toLowerCase()
  if (!lang || lang === to) return false
  if (lang === 'latn') {
    // Latin letters too few to name the language ("ok thanks", "LGTM").
    if (LATIN_READERS.has(to)) return false
    const words = body.replace(/https?:\/\/\S+|[@＠]\S+/g, ' ').match(/\p{L}+/gu) || []
    return words.length > 3
  }
  if ((lang === 'zh' && to === 'ja') || (lang === 'ja' && to === 'zh')) {
    // A few characters of kanji alone are as much Japanese as Chinese.
    const letters = body.replace(/[^\p{L}]/gu, '')
    if (letters.length > 0 && letters.length <= 12 && /^\p{Script=Han}+$/u.test(letters)) return false
  }
  return true
}

/// The same words, give or take case, spacing and punctuation.
export function sameWords(a: string, b: string): boolean {
  const plain = (x: string) => String(x || '').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '')
  return plain(a) === plain(b)
}
