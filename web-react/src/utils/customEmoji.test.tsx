import { describe, it, expect, vi, afterEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { loadCustomEmoji, customEmojiUrl, emojiNameFrom } from './customEmoji'
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
    // Alone on its line, larger.
    expect(html(':shogun_party:')).toContain('slk-custom-emoji big')
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
