import { describe, it, expect, vi, afterEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { loadCustomEmoji, customEmojiUrl, emojiNameFrom, customEmojiFailed } from './customEmoji'
import { renderRich, EmojiGlyph } from '../components/MessageParts'
import { emojiQuery, matchEmoji } from '../components/MentionMenu'

// A workspace's own emoji are drawn only in that workspace, and only for
// names it has.

const html = (text: string) => renderToStaticMarkup(<>{renderRich(text, () => 'm')}</>)
const serve = (emoji: Array<{ name: string; url: string }>) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ emoji }), { status: 200 })))
afterEach(() => { vi.unstubAllGlobals() })

describe('workspace emoji', () => {
  it('draws a name the workspace has, and leaves any other as text', async () => {
    serve([{ name: 'shogun_party', url: 'https://api.example/emoji/img/emoji-1' }])
    await loadCustomEmoji('https://api.example', 'tok', 'org:shogun')
    expect(html('done :shogun_party: now')).toContain('<img class="slk-custom-emoji" src="https://api.example/emoji/img/emoji-1" alt=":shogun_party:"')
    expect(html('done :other: now')).toBe('done :other: now')
    // Alone on its line, larger — and beside Unicode emoji, both larger.
    expect(html(':shogun_party:')).toContain('slk-custom-emoji big')
    expect(html(':shogun_party: 🎉')).toBe('<img class="slk-custom-emoji big" src="https://api.example/emoji/img/emoji-1" alt=":shogun_party:" title=":shogun_party:" draggable="false"/><span class="slk-emoji big"> 🎉</span>')
    // Inside bold it is not a line of its own.
    expect(html('*:shogun_party:* done')).not.toContain('big')
    // In code it is code.
    expect(html('`:shogun_party:`')).toBe('<code class="slk-code">:shogun_party:</code>')
    expect(renderToStaticMarkup(<EmojiGlyph emoji=":shogun_party:" />)).toContain('<img')
    expect(renderToStaticMarkup(<EmojiGlyph emoji="👍" />)).toBe('👍')
  })

  it('forgets one workspace the moment another opens', async () => {
    serve([{ name: 'shogun_party', url: 'u1' }])
    await loadCustomEmoji('https://api.example', 'tok', 'org:shogun')
    expect(customEmojiUrl(':shogun_party:')).toBe('u1')
    serve([])
    await loadCustomEmoji('https://api.example', 'tok', 'org:other')
    expect(customEmojiUrl(':shogun_party:')).toBeNull()
    expect(html(':shogun_party:')).toBe(':shogun_party:')
  })

  it('offers names after a colon and two letters', () => {
    expect(emojiQuery('nice :sh', 8)).toEqual({ start: 5, query: 'sh' })
    expect(emojiQuery('nice :s', 7)).toBeNull()
    expect(emojiQuery('10:30', 5)).toBeNull()
    const list = [{ name: 'shogun_lgtm', url: '', by: null, createdAt: '' }, { name: 'lgtm_shogun', url: '', by: null, createdAt: '' }]
    expect(matchEmoji(list, 'lgtm').map((e) => e.name)).toEqual(['lgtm_shogun', 'shogun_lgtm'])
    expect(emojiNameFrom('Shogun Party.svg')).toBe('shogun_party')
  })
})

const listed = (...emoji: Array<[string, string]>) => ({ ok: true, json: async () => ({ emoji: emoji.map(([name, url]) => ({ name, url, by: null, createdAt: '' })) }) })

// A picture that will not load, because somebody removed or replaced the
// emoji while this list was open, is never drawn as a broken picture.
describe('a workspace emoji whose picture stops loading', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('comes back at its new address when it was replaced under the same name', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(listed(['party', 'https://api/emoji/img/old'])).mockResolvedValueOnce(listed(['party', 'https://api/emoji/img/new']))
    vi.stubGlobal('fetch', fetch)
    await loadCustomEmoji('https://api', 't', 'org-replaced')
    expect(customEmojiUrl(':party:')).toBe('https://api/emoji/img/old')
    await customEmojiFailed('https://api/emoji/img/old', 1_000_000)
    expect(customEmojiUrl(':party:')).toBe('https://api/emoji/img/new')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('goes back to text when it was removed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(listed(['gone', 'https://api/emoji/img/gone'])).mockResolvedValueOnce(listed()))
    await loadCustomEmoji('https://api', 't', 'org-removed')
    await customEmojiFailed('https://api/emoji/img/gone', 2_000_000)
    expect(customEmojiUrl(':gone:')).toBeNull()
  })

  it('is drawn as text when it is still listed but its picture still does not load', async () => {
    const fetch = vi.fn().mockResolvedValue(listed(['lost', 'https://api/emoji/img/lost']))
    vi.stubGlobal('fetch', fetch)
    await loadCustomEmoji('https://api', 't', 'org-lost')
    await customEmojiFailed('https://api/emoji/img/lost', 3_000_000)
    expect(customEmojiUrl(':lost:')).toBeNull()
    // Asked about once a minute at most, however often it fails.
    await customEmojiFailed('https://api/emoji/img/lost', 3_000_500)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('gets another try when the list is read again, after a bad connection', async () => {
    const fetch = vi.fn().mockResolvedValue(listed(['flaky', 'https://api/emoji/img/flaky']))
    vi.stubGlobal('fetch', fetch)
    await loadCustomEmoji('https://api', 't', 'org-flaky')
    await customEmojiFailed('https://api/emoji/img/flaky', 4_000_000)
    expect(customEmojiUrl(':flaky:')).toBeNull()
    await loadCustomEmoji('https://api', 't', 'org-flaky')
    expect(customEmojiUrl(':flaky:')).toBe('https://api/emoji/img/flaky')
  })
})
