import type { DecisionCard } from '../types/card'

// The language a card is written in, as far as "does this need translating
// for me?" cares. No model call — a copy of worker/src/language.js, so the
// Worker and the page agree about which cards to ask about. "und" means the
// text is words this cannot place; it is nobody's language, so such a card
// is asked about, and the translator returns it unchanged if it was yours.

// Scripts that name their language, or near enough that asking the model
// is the right answer to the exceptions. Han and kana are weighed together
// below, because Japanese is written in both.
const SCRIPTS: Array<[string, RegExp]> = [
  ['hangul', /[ᄀ-ᇿ㄰-㆏가-힯]/g],
  ['kana', /[぀-ヿㇰ-ㇿｦ-ﾟ]/g],
  ['han', /[㐀-䶿一-鿿豈-﫿]/g],
  ['cyrillic', /[Ѐ-ӿ]/g],
  ['greek', /[Ͱ-Ͽ]/g],
  ['armenian', /[԰-֏]/g],
  ['hebrew', /[֐-׿]/g],
  ['arabic', /[؀-ۿݐ-ݿ]/g],
  ['devanagari', /[ऀ-ॿ]/g],
  ['bengali', /[ঀ-৿]/g],
  ['gurmukhi', /[਀-੿]/g],
  ['gujarati', /[઀-૿]/g],
  ['tamil', /[஀-௿]/g],
  ['telugu', /[ఀ-౿]/g],
  ['kannada', /[ಀ-೿]/g],
  ['malayalam', /[ഀ-ൿ]/g],
  ['sinhala', /[඀-෿]/g],
  ['thai', /[฀-๿]/g],
  ['lao', /[຀-໿]/g],
  ['myanmar', /[က-႟]/g],
  ['georgian', /[Ⴀ-ჿ]/g],
  ['ethiopic', /[ሀ-፿]/g],
  ['khmer', /[ក-៿]/g],
  ['latin', /[A-Za-zÀ-ɏḀ-ỿ]/g],
]

// One CJK character carries about as much as a short Latin word, so a
// Japanese sentence with an English product name in it is still Japanese.
const WEIGHT: Record<string, number> = { hangul: 3, kana: 3, han: 3 }

const BY_SCRIPT: Record<string, string> = {
  hangul: 'ko', greek: 'el', armenian: 'hy', hebrew: 'he', devanagari: 'hi',
  bengali: 'bn', gurmukhi: 'pa', gujarati: 'gu', tamil: 'ta', telugu: 'te',
  kannada: 'kn', malayalam: 'ml', sinhala: 'si', thai: 'th', lao: 'lo',
  myanmar: 'my', georgian: 'ka', ethiopic: 'am', khmer: 'km',
}

// The most common short words of the Latin-script languages people most
// often work in. A word listed under two languages counts for both.
const WORDS: Record<string, string> = {
  en: 'the a an and of to is are for with this that please we you it on be by from need needs approve can will should our your before has have was not do if or at as approval needed decision review update task new request requested meeting',
  es: 'el la los las de del que y en por para con es un una se no al lo como más pero sus esta este favor necesitamos aprobar antes hay son está',
  fr: 'le la les des du de et est pour que qui dans un une pas avec sur nous vous il au aux ce cette être merci veuillez avant sont ou',
  de: 'der die das und ist nicht mit für den dem ein eine zu von auf wir sie es bitte bis auch im des oder wird werden sind vor',
  pt: 'o a os as de do da dos das que e em para com não um uma é por no na se mais você nós favor antes são está',
  it: 'il lo la gli le di che e è per con non un una del della sono anche questo questa grazie prima entro',
  nl: 'de het een en van is dat niet voor met op te zijn wij je ook naar graag alstublieft deze wordt',
  id: 'yang dan di ke dari untuk ini itu dengan tidak kami kita anda akan ada pada mohon sudah bisa sebelum',
  tr: 've bir bu için ile de da değil ne çok mi ama olarak lütfen var yok önce',
  pl: 'i w z na nie się że do jest to jak po dla od proszę czy przed',
  sv: 'och att det som en är på för med inte av till har vi ni jag innan',
}
const LEXICON = new Map<string, string[]>()
for (const [lang, list] of Object.entries(WORDS)) {
  for (const word of list.split(' ')) {
    if (!LEXICON.has(word)) LEXICON.set(word, [])
    LEXICON.get(word)!.push(lang)
  }
}

// Letters that belong to a few languages and not to the others.
const MARKS: Array<[RegExp, string, number]> = [
  [/[ñ¿¡]/g, 'es', 2],
  [/[ãõ]/g, 'pt', 2],
  [/ß/g, 'de', 2],
  [/[äöü]/g, 'de', 1],
  [/[ığş]/g, 'tr', 2],
  [/[łąęśźżń]/g, 'pl', 2],
  [/å/g, 'sv', 2],
  [/[èêëîïûùœ]/g, 'fr', 1],
  [/[ìò]/g, 'it', 1],
]

// Vietnamese is Latin script, and its stacked diacritics are its own.
const VIETNAMESE = /[ăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/gi

function count(text: string, re: RegExp): number {
  return (text.match(re) || []).length
}

function latinLanguage(text: string): string {
  const lower = text.toLowerCase()
  if (count(lower, VIETNAMESE) >= 2) return 'vi'
  const score: Record<string, number> = {}
  for (const word of lower.match(/\p{L}+/gu) || []) {
    for (const lang of LEXICON.get(word) || []) score[lang] = (score[lang] || 0) + 1
  }
  for (const [re, lang, weight] of MARKS) {
    const n = count(lower, re)
    if (n) score[lang] = (score[lang] || 0) + weight * Math.min(n, 3)
  }
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1])
  const [top, second] = ranked
  // Two signals, and clearly ahead: anything less is a guess, and a wrong
  // "this is already yours" is the one mistake a reader cannot recover from.
  if (!top || top[1] < 2) return 'und'
  if (second && top[1] < second[1] * 1.5) return 'und'
  return top[0]
}

export function detectLanguage(text: string | null | undefined): string | null {
  const sample = String(text || '')
  if (!sample.trim()) return null
  let best: string | null = null
  let bestScore = 0
  const counts: Record<string, number> = {}
  for (const [script, re] of SCRIPTS) {
    counts[script] = count(sample, re)
  }
  // Japanese is han and kana together; han alone is Chinese.
  const cjk = counts.han + counts.kana
  for (const [script, n] of Object.entries(counts)) {
    if (script === 'han' || script === 'kana') continue
    const s = n * (WEIGHT[script] || 1)
    if (s > bestScore) { best = script; bestScore = s }
  }
  if (cjk * 3 > bestScore) return counts.kana > 0 ? 'ja' : 'zh'
  if (!best) return null
  if (best === 'latin') return latinLanguage(sample)
  if (best === 'cyrillic') {
    if (/[ґєії]/i.test(sample)) return 'uk'
    return 'ru'
  }
  if (best === 'arabic') {
    if (/[ٹڈڑںے]/.test(sample)) return 'ur'
    if (/[پچژگی]/.test(sample)) return 'fa'
    return 'ar'
  }
  return BY_SCRIPT[best] || 'und'
}

/// The primary language of a locale tag: "ja-JP", "ja_JP" and "ja" are one
/// reader. Null for anything that is not a tag.
export function primaryLanguage(locale: unknown): string | null {
  if (typeof locale !== 'string') return null
  const primary = locale.trim().toLowerCase().split(/[-_]/)[0]
  return /^[a-z]{2,3}$/.test(primary) ? primary : null
}

/// Whether the reader of `locale` should be shown a translation of this card
/// that does not exist yet. Only a card known to be in their language is not.
export function needsLocalizing(card: Pick<DecisionCard, 'title' | 'summary' | 'localized'> & { originalLanguage?: string }, locale: string): boolean {
  const lang = primaryLanguage(locale)
  if (!lang) return false
  if (card.localized?.[lang]?.title) return false
  if (primaryLanguage(card.originalLanguage) === lang) return false
  const language = detectLanguage(`${card.title || ''} ${card.summary || ''}`)
  return Boolean(language) && language !== lang
}
