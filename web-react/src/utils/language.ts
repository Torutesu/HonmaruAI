import type { DecisionCard } from '../types/card'

// The language a card is written in, as far as "does this need translating
// for me?" cares. A script test, not a model call — the same one the Worker
// uses — so the two agree about which cards to ask about.
export function detectLanguage(text: string): string | null {
  const sample = String(text || '')
  if (!sample.trim()) return null
  if (/[぀-ヿ]/.test(sample)) return 'ja'
  if (/[가-힯]/.test(sample)) return 'ko'
  if (/[一-鿿]/.test(sample)) return 'zh'
  if (/[Ѐ-ӿ]/.test(sample)) return 'ru'
  return 'en'
}

/// Whether the reader of `locale` should be shown a translation of this card
/// that does not exist yet.
export function needsLocalizing(card: Pick<DecisionCard, 'title' | 'summary' | 'localized'>, locale: string): boolean {
  if (!locale) return false
  if (card.localized?.[locale]?.title) return false
  const language = detectLanguage(`${card.title || ''} ${card.summary || ''}`)
  return Boolean(language) && language !== locale
}
