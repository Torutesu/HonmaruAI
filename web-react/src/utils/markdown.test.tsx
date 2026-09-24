import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown, parseBlocks, parseInline, safeHref } from './markdown'

const html = (source: string) => renderToStaticMarkup(<Markdown source={source} />)

// A report is Markdown a model wrote from other people's words. It reads as a
// document, and nothing in it can become HTML or a script.
describe('markdown', () => {
  it('reads headings, lists and paragraphs', () => {
    const blocks = parseBlocks('## Waiting on you (2)\n- **Spring menu** — Yuki\n- Supplier price\n\n### Next\n1. Call Kenji\n2. Sign the lease\n\nThat is all.')
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'list', 'heading', 'list', 'paragraph'])
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 2 })
    expect(blocks[2]).toMatchObject({ kind: 'heading', level: 3 })
    expect(blocks[1]).toMatchObject({ kind: 'list', ordered: false })
    expect(blocks[3]).toMatchObject({ kind: 'list', ordered: true, start: 1 })
  })

  it('draws them as plain elements', () => {
    expect(html('## 決まったこと\n- 春メニュー — ユキ\n* 仕入れ')).toBe('<div><h2>決まったこと</h2><ul><li>春メニュー — ユキ</li><li>仕入れ</li></ul></div>')
    expect(html('3. three\n4. four')).toBe('<div><ol start="3"><li>three</li><li>four</li></ol></div>')
    expect(html('# Title')).toBe('<div><h2>Title</h2></div>')
    expect(html('#### Deep')).toBe('<div><h3>Deep</h3></div>')
  })

  it('reads bold, italic and code', () => {
    expect(html('a **bold** and *soft* and `code` word')).toBe('<div><p>a <strong>bold</strong> and <em>soft</em> and <code>code</code> word</p></div>')
    expect(html('- **Urgent:** *the lease*')).toBe('<div><ul><li><strong>Urgent:</strong> <em>the lease</em></li></ul></div>')
  })

  it('leaves an asterisk that is not emphasis alone', () => {
    expect(html('2 * 3 = 6')).toBe('<div><p>2 * 3 = 6</p></div>')
    expect(html('**never closed')).toBe('<div><p>**never closed</p></div>')
    expect(html('a `tick')).toBe('<div><p>a `tick</p></div>')
  })

  it('links only to http and https, in a new tab', () => {
    expect(html('[Notion page](https://notion.so/x?a=1&b=2)')).toBe(
      '<div><p><a href="https://notion.so/x?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">Notion page</a></p></div>',
    )
    expect(html('[click](javascript:alert(1))')).toBe('<div><p>click</p></div>')
    expect(html('[x](data:text/html,<b>hi</b>)')).not.toContain('<a')
    expect(html('[x](/relative)')).toBe('<div><p>x</p></div>')
    expect(safeHref('JavaScript:alert(1)')).toBeNull()
    expect(safeHref(' https://example.com ')).toBe('https://example.com/')
    expect(safeHref('http://')).toBeNull()
  })

  it('never lets HTML through', () => {
    const out = html('<script>alert(1)</script>\n\n## <img src=x onerror=alert(1)>\n- <b>bold?</b>')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('<img')
    expect(out).not.toContain('<b>')
    expect(out).toContain('&lt;script&gt;')
  })

  it('keeps a paragraph whole, and a wrapped list item on its item', () => {
    const blocks = parseBlocks('line one\nline two\n\n- item\n  continued\nafter')
    expect(blocks).toHaveLength(3)
    expect(blocks[0]).toEqual({ kind: 'paragraph', children: [{ kind: 'text', text: 'line one\nline two' }] })
    expect(blocks[1]).toEqual({ kind: 'list', ordered: false, start: 1, items: [[{ kind: 'text', text: 'item continued' }]] })
    expect(blocks[2]).toMatchObject({ kind: 'paragraph' })
  })

  it('reads nothing into an empty report', () => {
    expect(parseBlocks('')).toEqual([])
    expect(parseBlocks('\n\n  \n')).toEqual([])
    expect(parseInline('')).toEqual([])
  })
})

describe('markdown links', () => {
  it('keeps parentheses inside an address', () => {
    expect(html('[Lease](https://en.wikipedia.org/wiki/Lease_(law)) signed')).toBe(
      '<div><p><a href="https://en.wikipedia.org/wiki/Lease_(law)" target="_blank" rel="noopener noreferrer">Lease</a> signed</p></div>',
    )
  })
})
