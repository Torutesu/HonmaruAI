import { act, create } from 'react-test-renderer'
import { afterEach, describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Palette, pointerMoved } from './Palette'
import type { Place } from '../utils/places'

const api = { httpBase: 'http://relay.test', orgId: 'org-1', sessionToken: 'session' }
const noop = () => {}
const html = (props: Partial<React.ComponentProps<typeof Palette>>) =>
  renderToStaticMarkup(<Palette {...api} cards={[]} onPick={noop} onClose={noop} {...props} />)
/// The rows, in order, by the conversation each opens.
const rows = (out: string) => [...out.matchAll(/data-view="([^"]+)"/g)].map((m) => m[1])

const places: Place[] = [
  { view: 'b:general', kind: 'channel', name: 'general', handle: 'general' },
  { view: 'b:board', kind: 'channel', name: 'board', handle: 'board', private: true, unread: 3 },
  { view: 'dm:r1', kind: 'person', name: 'Kenji Tanaka', handle: 'kenji', mentions: 2 },
  { view: 'g:abc', kind: 'group', name: 'Kenji Tanaka, Ana Ruiz', fresh: true },
  { view: 'ag:7', kind: 'agent', name: 'Hayao', handle: 'hayao' },
]

afterEach(() => vi.unstubAllGlobals())

// ⌘K opened with nothing typed: where to go before anything else.
describe('Palette, with nothing typed', () => {
  it('lists conversations first: the one before, then what calls for you — not the one you are in', () => {
    const out = html({ places, recent: ['b:general', 'ag:7'], current: 'b:general' })
    expect(rows(out)).toEqual(['ag:7', 'dm:r1', 'b:board', 'g:abc'])
    expect(out.indexOf('Conversations')).toBeGreaterThan(-1)
    expect(out.indexOf('Conversations')).toBeLessThan(out.indexOf('Go to'))
    // The first row is the one Enter takes: back to where you were.
    expect(out).toMatch(/aria-selected="true"[^>]*data-view="ag:7"/)
  })

  it('says what each one is and what waits there, in words as well as marks', () => {
    const out = html({ places, recent: ['b:general'] })
    const row = (view: string) => out.slice(out.indexOf(`data-view="${view}"`), out.indexOf('</li>', out.indexOf(`data-view="${view}"`)))
    expect(row('b:general')).toContain('<span class="palette-lead" aria-hidden="true">#</span>')
    expect(row('b:board')).toContain('<svg')
    expect(row('b:board')).toContain('<span class="sr-only">Private</span>')
    expect(row('b:board')).toContain('<span aria-hidden="true">3</span><span class="sr-only">3 waiting on you</span>')
    expect(row('dm:r1')).toContain('<span class="palette-lead" aria-hidden="true">@</span>')
    expect(row('dm:r1')).toContain('<span class="palette-meta">@kenji</span>')
    expect(row('dm:r1')).toContain('<span aria-hidden="true">@2</span><span class="sr-only">2 mentions of you</span>')
    expect(row('g:abc')).toContain('<span class="palette-fresh"><span class="sr-only">New messages</span></span>')
  })

  it('says one mention as one', () => {
    const out = html({ places: [{ view: 'dm:r1', kind: 'person', name: 'Kenji Tanaka', mentions: 1 }] })
    expect(out).toContain('<span aria-hidden="true">@1</span><span class="sr-only">1 mention of you</span>')
  })

  it('knows the channels before the list has ever been drawn', () => {
    const out = html({ businesses: [{ slug: 'front-desk', name: 'Front desk' }, { slug: 'ops', name: 'Ops' }], recent: ['b:ops'] })
    expect(rows(out)).toEqual(['b:ops'])
    expect(out).toContain('>Ops</span>')
  })

  it('tells how to jump to a conversation in the box itself', () => {
    expect(html({})).toContain('placeholder="Jump to a conversation, or search messages and decisions')
  })
})

// A pointer resting on the list while ↓ scrolls it does not take the
// highlight back.
describe('pointerMoved', () => {
  it('is a move only where the pointer is somewhere else on the screen', () => {
    expect(pointerMoved({ x: 400, y: 300 }, { screenX: 400, screenY: 300, movementX: 0, movementY: 0 })).toBe(false)
    expect(pointerMoved({ x: 400, y: 300 }, { screenX: 400, screenY: 302 })).toBe(true)
  })

  it('judges the first move by how far it went', () => {
    expect(pointerMoved(null, { screenX: 400, screenY: 300, movementX: 0, movementY: 0 })).toBe(false)
    expect(pointerMoved(null, { screenX: 400, screenY: 300, movementX: 3, movementY: 0 })).toBe(true)
  })
})

describe('Harness cross-resource search', () => {
  const stubBrowser = () => {
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
    vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn(), visibilityState: 'visible' })
  }
  it('groups resources and hands a record result to its App and row', async () => {
    stubBrowser()
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input); requests.push(url)
      const data = url.includes('/hx/search/resources') ? {
        messages: [],
        files: [{ id: 'file-12345678-1234-1234-1234-123456789abc', path: 'docs/plan.md', source: 'workspace', matchedBy: 'content' }],
        records: [{ rowId: 'row-12345678', tableId: 'table-1', tableName: 'Tasks', appId: 'app-1' }],
        automations: [{ id: 'workflow-1', name: 'Weekly digest', enabled: true, triggerType: 'schedule' }],
      } : { members: [], hits: [], messages: [] }
      return { ok: true, json: async () => data } as Response
    }))
    const picked = vi.fn()
    let tree: ReturnType<typeof create> | undefined
    await act(async () => { tree = create(<Palette {...api} harnessSearch cards={[]} onPick={picked} onClose={noop} />) })
    const input = tree!.root.findByProps({ role: 'combobox' })
    await act(async () => {
      input.props.onChange({ target: { value: 'needle' } })
      await new Promise(resolve => setTimeout(resolve, 300))
    })
    const textOf = (node: any): string => typeof node === 'string' ? node : Array.isArray(node?.children) ? node.children.map(textOf).join('') : ''
    const options = tree!.root.findAllByProps({ role: 'option' })
    const headings = tree!.root.findAllByProps({ className: 'palette-group' }).map(textOf)
    expect(headings).toEqual(expect.arrayContaining(['Files', 'Records', 'Automations']))
    expect(requests.some(url => url.includes('/hx/search/resources'))).toBe(true)
    const record = options.find(option => textOf(option).includes('Record · row-1234'))
    expect(record).toBeTruthy()
    await act(async () => { record!.props.onClick() })
    expect(picked).toHaveBeenCalledWith({ kind: 'record', appId: 'app-1', tableId: 'table-1', rowId: 'row-12345678' })
    await act(async () => tree!.unmount())
  })

  it('keeps Simple search on its existing messages endpoint', async () => {
    stubBrowser()
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input); requests.push(url)
      return { ok: true, json: async () => ({ members: [], hits: [], messages: [] }) } as Response
    }))
    let tree: ReturnType<typeof create> | undefined
    await act(async () => { tree = create(<Palette {...api} cards={[]} onPick={noop} onClose={noop} />) })
    const input = tree!.root.findByProps({ role: 'combobox' })
    await act(async () => {
      input.props.onChange({ target: { value: 'needle' } })
      await new Promise(resolve => setTimeout(resolve, 300))
    })
    expect(requests.some(url => url.includes('/channels/search'))).toBe(true)
    expect(requests.some(url => url.includes('/hx/search/resources'))).toBe(false)
    await act(async () => tree!.unmount())
  })
})
