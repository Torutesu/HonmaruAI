import type { ChannelMessage, ReplyQuote } from '../types/card'

// Discord's inline reply, in the browser: the quote a reply shows of the
// message it answers. The Worker writes that quote whenever it hands a
// message out (channels.js quoteOf); this writes the same one here, for the
// "Replying to" bar over the composer and for a quote whose original is
// edited or unsent while the reply is on screen.

/// What a spoiler hides in a quote — the Worker's SPOILER_MASK.
export const SPOILER_MASK = '████'
const QUOTE_CHARS = 120

/// What the message renderer reads on a line before it reads a spoiler, in
/// its own order (MessageParts inline()): `code`, a link, an :emoji:, an
/// @name — each kept whole — and then ||a spoiler||, which never crosses a
/// line and holds no bar. The Worker's QUOTE_TOKENS.
const QUOTE_TOKENS = /(`[^`\n]+`|https?:\/\/[^\s<>"）」|]+|:[a-z0-9_+-]{1,30}:|[@＠][^\s@＠,，。、!?！？:;|]+)|\|\|[^|\n]+\|\|/g

/// A message's first words, as a reply quotes them — the Worker's
/// replyExcerpt, character for character: each ||spoiler|| hidden before
/// anything is cut, then one line. A spoiler is what the renderer would
/// hide, read on the message's own lines: a ```block``` is code across
/// lines, `code` only within one, and bars inside either open no spoiler.
/// A file is named when there are no words.
export function replyExcerpt(body: string | null | undefined, fileName: string | null = null, max = QUOTE_CHARS): string {
  const masked = String(body || '').split('```')
    .map((piece, i) => (i % 2 ? piece : piece.replace(QUOTE_TOKENS, (_all, kept?: string) => kept || SPOILER_MASK)))
    .join('```')
  const text = masked.replace(/\s+/g, ' ').trim() || (fileName ? `📎 ${fileName}` : '')
  const chars = Array.from(text)
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : text
}

/// The quote of a message on screen, as a reply to it carries it.
export function quoteOf(m: ChannelMessage): ReplyQuote {
  if (m.deleted) return { id: m.id, kind: null, authorName: null, authorRef: null, excerpt: '', deleted: true }
  return {
    id: m.id,
    kind: m.kind,
    authorName: m.kind === 'ai' ? null : m.authorName,
    authorRef: m.authorRef,
    excerpt: replyExcerpt(m.body, m.files?.[0]?.name || null),
    deleted: false,
  }
}

/// A message changed — edited, or unsent — and every reply in `list` that
/// quotes it quotes it as it is now. The same list back when none does, so
/// nothing redraws for it.
export function refreshQuotes(list: ChannelMessage[], changed: ChannelMessage): ChannelMessage[] {
  if (!list.some((x) => x.replyTo?.id === changed.id)) return list
  const quote = quoteOf(changed)
  return list.map((x) => (x.replyTo?.id === changed.id ? { ...x, replyTo: quote } : x))
}

/// A message unsent, gone from a conversation's list, and with it the
/// replies of its thread that were sent to the conversation too — they went
/// with the thread. The same list back when nothing in it goes.
export function withoutThread(list: ChannelMessage[], id: string): ChannelMessage[] {
  if (!list.some((x) => x.id === id || x.parentId === id)) return list
  return list.filter((x) => x.id !== id && x.parentId !== id)
}

/// An excerpt in pieces to draw: its words, and null where a spoiler was
/// hidden — drawn as a bar a screen reader can name.
export function excerptParts(excerpt: string): Array<string | null> {
  const out: Array<string | null> = []
  excerpt.split(SPOILER_MASK).forEach((part, i) => {
    if (i > 0) out.push(null)
    if (part) out.push(part)
  })
  return out
}
