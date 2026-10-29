import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { renderRich, prefixLines, continueBlock, bulletOnSpace, lineMark, BULLET } from './MessageParts'

const html = (text: string) => renderToStaticMarkup(<>{renderRich(text, () => 'mention')}</>)

// A message's formatting, the way Slack reads it.
describe('renderRich', () => {
  it('renders safe labeled links for the shared conversation and thread formatter', () => {
    expect(html('Read [the report](https://example.com/report)')).toBe('Read <a href="https://example.com/report" target="_blank" rel="noopener noreferrer">the report</a>')
    expect(html('[nested](https://example.com/a_(b_(c)))')).toBe('<a href="https://example.com/a_(b_(c))" target="_blank" rel="noopener noreferrer">nested</a>')
    expect(html('*Read [the report](https://example.com/report)* @Mika')).toContain('<b>Read <a href="https://example.com/report"')
    expect(html('[bad](javascript:alert(1)) [data](data:text/html,hello)')).not.toContain('<a')
    expect(html('https://example.com/a_(b)')).toContain('href="https://example.com/a_(b)"')
    expect(html('[app](#/apps/a/org) [flow](#/workflows/w/org)')).toBe('<a href="#/apps/a/org" class="hx-inline-app-link">app</a> <a href="#/workflows/w/org" class="hx-inline-app-link">flow</a>')
    expect(html('`[code](https://example.com)`')).toBe('<code class="slk-code">[code](https://example.com)</code>')
  })

  it('puts one blank line between a list and the paragraph after it, not two', () => {
    const out = html('*Done*\n- a\n- b\n\n*Tomorrow*\n- c')
    expect(out).toBe('<b>Done</b><ul class="slk-ul"><li>a</li><li>b</li></ul><br/><b>Tomorrow</b><ul class="slk-ul"><li>c</li></ul>')
  })

  it('still breaks plain lines, and a line straight after a list starts on its own', () => {
    expect(html('one\ntwo')).toBe('one<br/>two')
    expect(html('- a\nafter')).toBe('<ul class="slk-ul"><li>a</li></ul>after')
    expect(html('> quoted\nplain')).toBe('<blockquote class="slk-quote">quoted</blockquote>plain')
  })

  it('reads quoted lines one after another as one quote', () => {
    expect(html('> one\n> two\nafter')).toBe('<blockquote class="slk-quote">one<br/>two</blockquote>after')
  })

  it('draws a line of nothing but emoji large, and emoji among words as they are', () => {
    expect(html('🎉')).toBe('<span class="slk-emoji big">🎉</span>')
    expect(html('👍 🙏\nthanks 🙏')).toBe('<span class="slk-emoji big">👍 🙏</span><br/>thanks 🙏')
    expect(html('- 🚀')).toBe('<ul class="slk-ul"><li><span class="slk-emoji big">🚀</span></li></ul>')
    expect(html('*🎉* shipped')).toBe('<b>🎉</b> shipped')
    expect(html('*🎉*')).toBe('<b>🎉</b>')
    expect(html('`🎉`')).toBe('<code class="slk-code">🎉</code>')
  })

  it('draws a numbered list, keeping its numbers, apart from bullets', () => {
    expect(html('1. a\n2. b\n- c')).toBe('<ol class="slk-ol"><li value="1">a</li><li value="2">b</li></ol><ul class="slk-ul"><li>c</li></ul>')
  })
})

// Discord's marks, beside Slack's.
describe('renderRich, the Discord way', () => {
  it('hides a ||spoiler|| until it is revealed, and keeps the words out of the accessible name', () => {
    const out = html('the end: ||he was a ghost||!')
    expect(out).toBe('the end: <span class="slk-spoiler" role="button" tabindex="0" aria-label="Spoiler, press to reveal"><span aria-hidden="true">he was a ghost</span></span>!')
  })

  it('formats inside a spoiler, and a link inside it stops at the bars', () => {
    expect(html('||*big*||')).toContain('<span aria-hidden="true"><b>big</b></span>')
    expect(html('||https://x.test/a||')).toContain('<a href="https://x.test/a"')
  })

  it('reads __underline__ and ~~strike~~ as one mark, not two single ones', () => {
    expect(html('__under__')).toBe('<u>under</u>')
    expect(html('~~gone~~')).toBe('<s>gone</s>')
    expect(html('_it_ ~s~')).toBe('<i>it</i> <s>s</s>')
  })

  it('preserves underscores in identifiers instead of joining unrelated italic spans', () => {
    const source = 'add_numbers list_app_actions run_app_action get_app_execution file_name.txt';
    expect(html(source)).toBe(source)
    expect(html('foo__bar__baz 日本語_項目_名')).toBe('foo__bar__baz 日本語_項目_名')
    expect(html('(_italic_) and __under__')).toBe('(<i>italic</i>) and <u>under</u>')
  })

  it('draws #, ## and ### headings and -# subtext as lines of their own', () => {
    expect(html('# Big\ntext')).toBe('<div class="slk-h slk-h1" role="heading" aria-level="3">Big</div>text')
    expect(html('### Small')).toBe('<div class="slk-h slk-h3" role="heading" aria-level="5">Small</div>')
    expect(html('-# fine print')).toBe('<div class="slk-subtext">fine print</div>')
  })

  it('leaves #channel, #hashtags and a lone # as they are', () => {
    expect(html('#general')).toBe('#general')
    expect(html('#### four')).toBe('#### four')
    expect(html('- a\n- b')).toBe('<ul class="slk-ul"><li>a</li><li>b</li></ul>')
  })
})

// A composer box, as far as the format buttons touch it.
function box(value: string, start: number, end = start) {
  const state = { value, el: { selectionStart: start, selectionEnd: end, focus() {}, setSelectionRange(a: number, b: number) { this.selectionStart = a; this.selectionEnd = b } } }
  return { state, set: (v: string) => { state.value = v } }
}
globalThis.requestAnimationFrame = ((f: FrameRequestCallback) => { f(0); return 0 }) as typeof requestAnimationFrame

describe('the quote and list buttons', () => {
  it('mark every selected line, and take the mark off again', () => {
    const { state, set } = box('one\ntwo', 0, 7)
    prefixLines(state.el as unknown as HTMLTextAreaElement, state.value, set, '> ')
    expect(state.value).toBe('> one\n> two')
    prefixLines(state.el as unknown as HTMLTextAreaElement, state.value, set, '> ')
    expect(state.value).toBe('one\ntwo')
  })

  it('mark the line the caret is on in an empty box, and keep the caret after the mark', () => {
    const { state, set } = box('', 0)
    prefixLines(state.el as unknown as HTMLTextAreaElement, state.value, set, '- ')
    expect(state.value).toBe('- ')
    expect(state.el.selectionStart).toBe(2)
  })

  it('turn a quote into a list rather than stack marks, and number a numbered one', () => {
    const { state, set } = box('> a\n> b', 0, 7)
    prefixLines(state.el as unknown as HTMLTextAreaElement, state.value, set, '1. ')
    expect(state.value).toBe('1. a\n2. b')
  })

  it('carry the mark to a new line, and end the list on an empty one', () => {
    const { state, set } = box('- milk', 6)
    expect(continueBlock(state.el as unknown as HTMLTextAreaElement, state.value, set)).toBe(true)
    expect(state.value).toBe('- milk\n- ')
    state.el.selectionStart = state.el.selectionEnd = state.value.length
    expect(continueBlock(state.el as unknown as HTMLTextAreaElement, state.value, set)).toBe(true)
    expect(state.value).toBe('- milk\n')
    const n = box('1. a', 4)
    continueBlock(n.state.el as unknown as HTMLTextAreaElement, n.state.value, n.set)
    expect(n.state.value).toBe('1. a\n2. ')
    const plain = box('hello', 5)
    expect(continueBlock(plain.state.el as unknown as HTMLTextAreaElement, plain.state.value, plain.set)).toBe(false)
  })

  it('write a bullet as the dot it is drawn with, and take an old "- " off as the same bullet', () => {
    const { state, set } = box('milk', 0)
    prefixLines(state.el as unknown as HTMLTextAreaElement, state.value, set, BULLET)
    expect(state.value).toBe('• milk')
    const old = box('- a\n- b', 0, 7)
    prefixLines(old.state.el as unknown as HTMLTextAreaElement, old.state.value, old.set, BULLET)
    expect(old.state.value).toBe('a\nb')
    expect(html('• a\n• b')).toBe('<ul class="slk-ul"><li>a</li><li>b</li></ul>')
  })

  it('turn "- " or "* " typed at the start of a line into a bullet, and nothing else', () => {
    const typed = (value: string, caret: number, data = ' ', inputType = 'insertText') =>
      bulletOnSpace({ target: { value, selectionStart: caret, setSelectionRange() {} }, nativeEvent: { inputType, data } } as unknown as React.ChangeEvent<HTMLTextAreaElement>)
    expect(typed('- ', 2)).toBe('• ')
    expect(typed('first\n* ', 8)).toBe('first\n• ')
    expect(typed('a - ', 4)).toBe('a - ')
    expect(typed('- ', 2, ' ', 'deleteContentBackward')).toBe('- ')
    expect(typed('*bold* ', 7)).toBe('*bold* ')
  })

  it('know which mark the caret’s line has', () => {
    expect(lineMark('a\n• b', 4)).toBe('bullet')
    expect(lineMark('a\n• b', 1)).toBe(null)
    expect(lineMark('2. x', 4)).toBe('numbered')
    expect(lineMark('> q', 3)).toBe('quote')
  })
})

// An @name that is a person opens their profile; any other stays a word
// in colour.
describe('a mention', () => {
  const look = (name: string) => (name === '@Mika' ? { className: 'slk-mention', ref: 'm1' } : name === '@sales' ? { className: 'slk-mention group' } : 'slk-mention')
  const draw = (text: string) => renderToStaticMarkup(<>{renderRich(text, look)}</>)
  it('presses like a button and carries the person’s ref, for one handler on the conversation to open', () => {
    expect(draw('ask @Mika')).toBe('ask <span role="button" tabindex="0" class="slk-mention link" data-mention-ref="m1" aria-haspopup="dialog">@Mika</span>')
    expect(draw('*@Mika*')).toContain('<b><span role="button" tabindex="0" class="slk-mention link" data-mention-ref="m1"')
  })
  it('is still a word of the message, so selecting and copying the message takes it too', () => {
    // A <button>'s text is left out of a selection (Firefox: user-select: none).
    expect(draw('ask @Mika about it')).not.toContain('<button')
  })
  it('stays a span for a group, or a class given alone', () => {
    expect(draw('@sales and @AI')).toBe('<span class="slk-mention group">@sales</span> and <span class="slk-mention">@AI</span>')
  })
})

describe('a Jam recording in a message', () => {
  it('plays where it was posted, from an address asked for then; any other link stays a link', () => {
    const url = 'https://api.example.com/channels/jam/audio/0f8b3c3e-1111-4222-8333-944455556666'
    // The link alone opens nothing: the player waits for a signed address.
    expect(html(`Recording: ${url}`)).toBe('Recording: <audio class="slk-jam-audio" controls="" preload="none"></audio>')
    expect(html('see https://example.com/channels/jam/audio/nope')).toContain('<a href="https://example.com/channels/jam/audio/nope"')
  })
})

describe('the links a message unfurls', () => {
  it('takes the first two, trims punctuation, skips a Jam recording', async () => {
    const { unfurlable } = await import('./MessageParts')
    expect(unfurlable('see https://a.example/x, and https://b.example/y! https://c.example/z')).toEqual(['https://a.example/x', 'https://b.example/y'])
    expect(unfurlable('https://h.example/channels/jam/audio/0f8fad5b-d9cb-469f-a165-70867728950e')).toEqual([])
    expect(unfurlable('no links')).toEqual([])
  })
})

describe('the emoji picker', () => {
  it('opens on a search box, the usual emoji, and every group once the list is here', async () => {
    const { EmojiPicker } = await import('./MessageParts')
    const { loadEmojiData } = await import('../utils/emojiSearch')
    const draw = () => renderToStaticMarkup(<EmojiPicker onPick={() => {}} onClose={() => {}} />)
    const before = draw()
    expect(before).toContain('<input class="slk-picker-search" type="search" placeholder="Search emoji" aria-label="Search emoji"')
    expect(before).toContain('Frequently used')
    expect(before).not.toContain('Smileys &amp; people')
    // It says the rest is on its way, rather than look complete.
    expect(before).toContain('data-emoji-list="loading">Loading…</p>')
    await loadEmojiData()
    const after = draw()
    expect(after).toContain('Smileys &amp; people')
    expect(after).not.toContain('data-emoji-list')
    expect(after).toContain('aria-label="👍" title=":+1:"')
    // One stop for Tab; the arrows do the rest.
    expect(after.match(/tabindex="0"/g)).toHaveLength(1)
    expect(after.match(/data-cell="/g)!.length).toBeGreaterThan(380)
  })
})

describe('the hover bar’s reactions', () => {
  it('are the usual three, then the ones you reacted with last, each staying where it is', async () => {
    const { QuickReactions } = await import('./MessageParts')
    const { rememberEmoji } = await import('../utils/emojiSearch')
    const bar = () => [...renderToStaticMarkup(<QuickReactions onReact={() => {}} />).matchAll(/aria-label="React with ([^"]+)"/g)].map((m) => m[1])
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
    expect(bar()).toEqual(['✅', '👀', '🙌'])
    rememberEmoji('🔥')
    expect(bar()).toEqual(['✅', '👀', '🔥'])
    // One already in the bar, clicked: it does not move from under the pointer.
    rememberEmoji('👀')
    expect(bar()).toEqual(['✅', '👀', '🔥'])
    rememberEmoji('🎉')
    expect(bar()).toEqual(['🎉', '👀', '🔥'])
    vi.unstubAllGlobals()
  })
})

describe('who reacted', () => {
  it('is a sentence in the reader’s language, with the rest counted when there are many', async () => {
    const { reactorNames } = await import('./MessageParts')
    const more = (n: number) => `${n} others`
    expect(reactorNames(['Aya', 'Ken', 'You'], 'en', more)).toBe('Aya, Ken, and You')
    expect(reactorNames(['Aya'], 'en', more)).toBe('Aya')
    expect(reactorNames(['あや', 'けん', 'あなた'], 'ja', more)).toBe('あや、けん、あなた')
    const many = Array.from({ length: 15 }, (_, i) => `P${i + 1}`)
    expect(reactorNames(many, 'en', more)).toBe('P1, P2, P3, P4, P5, P6, P7, P8, P9, P10, P11, P12, and 3 others')
  })
})

describe('the typing line', () => {
  it('shows who is typing with the dots, kept out of a screen reader’s way', async () => {
    const { TypingLine } = await import('./MessageParts')
    const out = renderToStaticMarkup(<TypingLine names={['Aki', 'Ben']} />)
    expect(out).toContain('<div class="slk-typing-people" data-typing="1">')
    expect(out).toContain('<span class="slk-typing-now" aria-hidden="true"><span class="slk-dots"><i></i><i></i><i></i></span><span class="slk-typing-text">Aki and Ben are typing…</span></span>')
    // Its own polite region, told once the line is on screen.
    expect(out).toContain('<span class="sr-only" role="status" aria-live="polite" aria-atomic="true"></span>')
  })

  it('keeps its region with nobody typing, so the next one is heard', async () => {
    const { TypingLine } = await import('./MessageParts')
    expect(renderToStaticMarkup(<TypingLine names={[]} />)).toBe('<div class="slk-typing-people"><span class="sr-only" role="status" aria-live="polite" aria-atomic="true"></span></div>')
  })
})

describe('an inline reply', () => {
  const quote = { id: 'm1', kind: 'message' as const, authorName: 'Mika', authorRef: 'r-mika', excerpt: 'the code is ████ ok', deleted: false }

  it('quotes who it answers above its words, a hidden spoiler as a named bar, and goes to the original', async () => {
    const { ReplyQuoteLine } = await import('./MessageParts')
    const out = renderToStaticMarkup(<ReplyQuoteLine quote={quote} name="Mika" onJump={() => {}} />)
    expect(out).toMatch(/^<button type="button" class="slk-reply-quote" title="Go to the message" data-reply-to="m1">/)
    expect(out).toContain('<span class="sr-only">In reply to </span><b class="slk-reply-who">Mika</b>')
    expect(out).toContain('the code is <span class="slk-reply-spoiler" role="img" aria-label="Spoiler"></span> ok')
    expect(out).not.toContain('████')
  })

  it('says only that the original is gone, with nothing to press', async () => {
    const { ReplyQuoteLine } = await import('./MessageParts')
    const out = renderToStaticMarkup(<ReplyQuoteLine quote={{ ...quote, deleted: true, kind: null, authorName: null, authorRef: null, excerpt: '' }} name="" onJump={() => {}} />)
    expect(out).toContain('class="slk-reply-quote gone"')
    expect(out).toContain('Original message was deleted')
    expect(out).not.toContain('<button')
  })

  it('shows what is being answered over the composer, with a way out', async () => {
    const { ReplyingBar } = await import('./MessageParts')
    const out = renderToStaticMarkup(<ReplyingBar quote={quote} name="Mika" textId="replying-text" onCancel={() => {}} />)
    expect(out).toContain('<span class="slk-replying-text" id="replying-text">Replying to Mika <span class="slk-replying-excerpt">the code is ')
    expect(out).toContain('aria-label="Cancel reply"')
  })

  it('is offered in the hover bar wherever the list asks for it', async () => {
    const { MessageActions } = await import('./MessageParts')
    const m = { id: 'm1', channel: 'b:cafe', kind: 'message' as const, body: 'hi', authorName: 'Mika', authorRef: 'r-mika', mine: false, cardId: null, createdAt: '' }
    const bar = renderToStaticMarkup(<MessageActions message={m} onReact={() => {}} onQuote={() => {}} onOpenChange={() => {}} />)
    expect(bar).toContain('aria-label="Reply" data-tool="quote"')
    expect(renderToStaticMarkup(<MessageActions message={m} onReact={() => {}} onOpenChange={() => {}} />)).not.toContain('data-tool="quote"')
  })
})

// Under a message of yours the server does not have yet.
describe('the note under a message on its way', () => {
  const said = { id: 'tmp-1', channel: 'b:hotel', kind: 'message' as const, body: 'Rooms are ready', authorName: 'Aiko', authorRef: 'm-aiko', mine: true, cardId: null, createdAt: '2026-09-30T09:00:00.000Z' }
  const note = async (extra: object) => {
    const { UnsentNote } = await import('./MessageParts')
    return renderToStaticMarkup(<UnsentNote message={{ ...said, ...extra }} onRetry={() => {}} onDelete={() => {}} onEdit={() => {}} />)
  }

  it('says why it did not go, as an alert, with Retry and Delete', async () => {
    const html = await note({ failed: 'That did not send. Try again.' })
    expect(html).toContain('role="alert"')
    expect(html).toContain('That did not send. Try again.')
    expect(html).toMatch(/<button type="button" class="slk-unsent-act" data-unsent-retry="1">.*Retry<\/button>/)
    expect(html).toMatch(/<button type="button" class="slk-unsent-act" data-unsent-delete="1">.*Delete<\/button>/)
    expect(html).not.toContain('data-unsent-edit')
  })

  it('refused for what it says, offers Edit in place of Retry — the same words would be refused again', async () => {
    const html = await note({ failed: 'This can’t be sent here.', refused: true })
    expect(html).toContain('This can’t be sent here.')
    expect(html).toMatch(/<button type="button" class="slk-unsent-act" data-unsent-edit="1">.*Edit<\/button>/)
    expect(html).toContain('data-unsent-delete="1"')
    expect(html).not.toContain('data-unsent-retry')
  })

  it('only tells a screen reader it is on its way — it is drawn dimmed', async () => {
    expect(await note({ pending: true })).toBe('<span class="sr-only">Sending…</span>')
  })

  it('on its way for longer than a send should take, says so with Delete', async () => {
    const { UnsentNote } = await import('./MessageParts')
    const at = (lateAt: number) => renderToStaticMarkup(<UnsentNote message={{ ...said, pending: true }} onRetry={() => {}} onDelete={() => {}} lateAt={lateAt} />)
    expect(at(Date.now() + 60_000)).toBe('<span class="sr-only">Sending…</span>')
    const late = at(Date.now() - 1)
    expect(late).toContain('class="slk-unsent late"')
    expect(late).toMatch(/<button type="button" class="slk-unsent-act" data-unsent-delete="1">.*Delete<\/button>/)
    expect(late).not.toContain('data-unsent-retry')
  })

  it('is nothing under a message the server has', async () => {
    expect(await note({ id: '0f9c-uuid' })).toBe('')
  })
})
