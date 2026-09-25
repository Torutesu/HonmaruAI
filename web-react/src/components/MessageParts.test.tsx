import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { renderRich } from './MessageParts'

const html = (text: string) => renderToStaticMarkup(<>{renderRich(text, () => 'mention')}</>)

// A message's formatting, the way Slack reads it.
describe('renderRich', () => {
  it('puts one blank line between a list and the paragraph after it, not two', () => {
    const out = html('*Done*\n- a\n- b\n\n*Tomorrow*\n- c')
    expect(out).toBe('<b>Done</b><ul class="slk-ul"><li>a</li><li>b</li></ul><br/><b>Tomorrow</b><ul class="slk-ul"><li>c</li></ul>')
  })

  it('still breaks plain lines, and a line straight after a list starts on its own', () => {
    expect(html('one\ntwo')).toBe('one<br/>two')
    expect(html('- a\nafter')).toBe('<ul class="slk-ul"><li>a</li></ul>after')
    expect(html('> quoted\nplain')).toBe('<blockquote class="slk-quote">quoted</blockquote>plain')
  })
})

describe('a Jam recording in a message', () => {
  it('plays where it was posted; any other link stays a link', () => {
    const url = 'https://api.example.com/channels/jam/audio/0f8b3c3e-1111-4222-8333-944455556666'
    expect(html(`Recording: ${url}`)).toBe(`Recording: <audio class="slk-jam-audio" controls="" preload="none" src="${url}"></audio>`)
    expect(html('see https://example.com/channels/jam/audio/nope')).toContain('<a href="https://example.com/channels/jam/audio/nope"')
  })
})
