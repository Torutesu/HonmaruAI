import { describe, it, expect } from 'vitest'
import type { ChannelMessage } from '../types/card'
import { SPOILER_MASK, replyExcerpt, quoteOf, refreshQuotes, excerptParts, withoutThread, displayedQuote, replySources } from './replies'

const msg = (over: Partial<ChannelMessage> = {}): ChannelMessage => ({
  id: 'm1', channel: 'b:cafe', kind: 'message', body: 'Roaster wants +8%', authorName: 'Mika', authorRef: 'r-mika',
  mine: false, cardId: null, createdAt: '2026-10-01T09:00:00.000Z', ...over,
})

// The same cases the Worker's test reads (test/inline-reply.test.js): the
// bar over the composer quotes a message exactly as the reply will.
describe('replyExcerpt', () => {
  it('puts it on one line and cuts it with an ellipsis', () => {
    expect(replyExcerpt('one\n\ntwo   three')).toBe('one two three')
    expect(replyExcerpt('x'.repeat(200))).toBe(`${'x'.repeat(119)}…`)
    expect(replyExcerpt('x'.repeat(120))).toBe('x'.repeat(120))
    // An emoji is not split in two by the cut.
    expect(Array.from(replyExcerpt('😀'.repeat(130)))).toHaveLength(120)
  })

  it('hides every spoiler, even one the cut would have halved', () => {
    expect(replyExcerpt('a ||b|| c ||d|| f')).toBe(`a ${SPOILER_MASK} c ${SPOILER_MASK} f`)
    const long = replyExcerpt(`${'a'.repeat(110)} ||the secret that runs past the cut||`)
    expect(long).not.toContain('secret')
    expect(long).not.toContain('||')
  })

  it('reads a spoiler as the renderer does: within one line, never across two', () => {
    expect(replyExcerpt('a ||b\nc|| d')).toBe('a ||b c|| d')
    // Bars on two lines must not pair up and leave the real one showing.
    expect(replyExcerpt('a || b\n||the secret|| c')).toBe(`a || b ${SPOILER_MASK} c`)
  })

  it('reads code before the lines are joined', () => {
    expect(replyExcerpt('```\nif (a || b) {}\nx || y\n``` ok')).toBe('``` if (a || b) {} x || y ``` ok')
    // Two stray backticks on different lines are not code, and protect
    // nothing between them.
    expect(replyExcerpt('use the ` key\n||the butler did it|| not the ` one')).toBe(`use the \` key ${SPOILER_MASK} not the \` one`)
    // A backtick inside a link opens no code either.
    expect(replyExcerpt('see https://x.test/`a ||b|| c`')).toBe(`see https://x.test/\`a ${SPOILER_MASK} c\``)
  })

  it('reads bars inside code as code, not as a spoiler', () => {
    expect(replyExcerpt('run `a || b` then ||c||')).toBe(`run \`a || b\` then ${SPOILER_MASK}`)
    expect(replyExcerpt('```if (a || b) {}``` ok')).toBe('```if (a || b) {}``` ok')
    expect(replyExcerpt('a || b')).toBe('a || b')
  })

  it('names a file when there are no words', () => {
    expect(replyExcerpt('', 'plan.pdf')).toBe('📎 plan.pdf')
    expect(replyExcerpt('see this', 'plan.pdf')).toBe('see this')
    expect(replyExcerpt(null)).toBe('')
  })
})

describe('quoteOf', () => {
  it('quotes a teammate by name and ref, the AI by neither', () => {
    expect(quoteOf(msg({ body: 'the code is ||1234||' }))).toEqual({
      id: 'm1', kind: 'message', authorName: 'Mika', authorRef: 'r-mika', excerpt: `the code is ${SPOILER_MASK}`, source: { channel: 'b:cafe', body: 'the code is ||1234||', lang: undefined, fileName: null }, deleted: false,
    })
    expect(quoteOf(msg({ kind: 'ai', authorName: null, authorRef: null }))).toMatchObject({ kind: 'ai', authorName: null, authorRef: null })
  })

  it('says only that an unsent message is gone', () => {
    expect(quoteOf(msg({ deleted: true, body: '' }))).toEqual({ id: 'm1', kind: null, authorName: null, authorRef: null, excerpt: '', deleted: true })
  })

  it('names the first file of a message that is only files', () => {
    const file = { id: 'f1', name: 'menu.png', type: 'image/png', size: 10, url: '/f1' }
    expect(quoteOf(msg({ body: '', files: [file] })).excerpt).toBe('📎 menu.png')
  })
})

describe('refreshQuotes', () => {
  const original = msg()
  const reply = msg({ id: 'm2', body: 'too much', authorName: 'Toru', authorRef: 'r-toru', replyTo: quoteOf(original) })
  const other = msg({ id: 'm3', body: 'unrelated' })

  it('brings an edit into every reply that quotes it', () => {
    const next = refreshQuotes([original, reply, other], { ...original, body: 'Roaster wants +6%', editedAt: '2026-10-01T09:05:00.000Z' })
    expect(next[1].replyTo?.excerpt).toBe('Roaster wants +6%')
    expect(next[2]).toBe(other)
  })

  it('marks the quote gone once the original is unsent', () => {
    const next = refreshQuotes([reply, other], { ...original, deleted: true, body: '' })
    expect(next[0].replyTo).toMatchObject({ id: 'm1', deleted: true, excerpt: '', authorName: null })
  })

  it('hands back the same list when nothing quotes the message', () => {
    const list = [original, other]
    expect(refreshQuotes(list, { ...other, body: 'changed' })).toBe(list)
  })
})

describe('withoutThread', () => {
  it('takes an unsent message and the replies of its thread shown in the conversation too', () => {
    const parent = msg({ id: 'p1' })
    const shared = msg({ id: 'r1', parentId: 'p1', alsoChannel: true })
    const elsewhere = msg({ id: 'r2', parentId: 'p2', alsoChannel: true })
    const plain = msg({ id: 'm9' })
    expect(withoutThread([parent, shared, elsewhere, plain], 'p1').map((x) => x.id)).toEqual(['r2', 'm9'])
  })

  it('takes only the reply when a reply is unsent, and hands back the same list when nothing goes', () => {
    const list = [msg({ id: 'p1' }), msg({ id: 'r1', parentId: 'p1', alsoChannel: true }), msg({ id: 'r3', parentId: 'p1', alsoChannel: true })]
    expect(withoutThread(list, 'r1').map((x) => x.id)).toEqual(['p1', 'r3'])
    expect(withoutThread(list, 'nope')).toBe(list)
  })
})

describe('excerptParts', () => {
  it('splits an excerpt at each hidden spoiler', () => {
    expect(excerptParts(`a ${SPOILER_MASK} b`)).toEqual(['a ', null, ' b'])
    expect(excerptParts(`${SPOILER_MASK}${SPOILER_MASK}`)).toEqual([null, null])
    expect(excerptParts('plain')).toEqual(['plain'])
    expect(excerptParts('')).toEqual([])
  })
})


describe('viewer reply excerpts (#522)', () => {
  it('resolves late translations at render time, using the source version and Show original policy', () => {
    const source = msg({ body: '明日から始めます', lang: 'ja' })
    const quote = quoteOf(source)
    expect(displayedQuote(quote, source.channel, undefined, () => source.body).excerpt).toBe(source.body)
    expect(displayedQuote(quote, source.channel, undefined, () => 'Starts tomorrow').excerpt).toBe('Starts tomorrow')
    expect(quote.excerpt).toBe(source.body)
    expect(replySources([msg({ id: 'reply', replyTo: quote })])[1].body).toBe(source.body)
    expect(displayedQuote(quote, 'b:elsewhere', undefined, () => 'private').excerpt).toBe(quote.excerpt)
  })
  it('uses the current source for edits and deletion, never a kept translation after unsend', () => {
    const quote = quoteOf(msg())
    expect(displayedQuote(quote, 'b:cafe', msg({ body: 'edited' }), m => m.body).excerpt).toBe('edited')
    expect(displayedQuote(quote, 'b:cafe', msg({ deleted: true }), () => 'private').deleted).toBe(true)
    expect(refreshQuotes([msg({ id: 'reply', threadParent: quote })], msg({ deleted: true }))[0].threadParent?.deleted).toBe(true)
  })
  it('falls back to masked original if a translator drops spoiler marks; preserves files and excerpt bounds', () => {
    const source = msg({ body: '秘密 ||1234||' })
    expect(displayedQuote(quoteOf(source), source.channel, source, () => 'secret 1234').excerpt).toBe('秘密 ████')
    expect(displayedQuote(quoteOf(msg()), 'b:cafe', msg(), () => '😀'.repeat(150)).excerpt).toBe('😀'.repeat(119) + '…')
    const file = msg({ body: '', files: [{ id: 'f', name: 'plan.pdf' } as any] })
    expect(displayedQuote(quoteOf(file), file.channel, file, () => '').excerpt).toBe('📎 plan.pdf')
  })
})
