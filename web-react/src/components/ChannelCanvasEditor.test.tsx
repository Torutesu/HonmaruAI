import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChannelCanvas } from './ChannelCanvas'

// The editor stays open while a save or an update is on its way: what the
// answer does must not take away words typed after it left.

const api = { httpBase: 'https://api.test', orgId: 'team:1', sessionToken: 's' }
const canvas = (body: string, version: number) => ({ body, version, updatedBy: 'Aiko', updatedAt: '2026-10-18T09:00:00.000Z' })
const reply = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data })

type Pending = { url: string; init?: RequestInit; resolve: (r: unknown) => void }

/// The canvas pane against a server whose every answer is given by hand.
async function mount() {
  const asked: Pending[] = []
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => new Promise((resolve) => asked.push({ url, init, resolve }))))
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  let tree!: ReactTestRenderer
  act(() => { tree = create(<ChannelCanvas api={api} headers={{}} view="b:hotel" title="hotel" onClose={() => {}} />) })
  await act(async () => { asked.shift()!.resolve(reply({ canvas: canvas('First', 1), revisions: [] })) })
  const button = (data: string) => tree.root.find((n) => n.type === 'button' && n.props[data] === '1')
  const editor = () => tree.root.findAll((n) => n.type === 'textarea')[0]
  const type = (value: string) => act(() => { editor().props.onChange({ target: { value } }) })
  const press = (data: string) => act(() => { button(data).props.onClick() })
  const answer = async (data: unknown, status = 200) => { await act(async () => { asked.shift()!.resolve(reply(data, status)) }) }
  return { tree, asked, button, editor, type, press, answer }
}

afterEach(() => vi.unstubAllGlobals())

describe('the canvas editor while a request is on its way', () => {
  it('a save acknowledges what was sent and keeps what was typed since, unsaved', async () => {
    const c = await mount()
    c.press('data-canvas-edit')
    c.type('First draft')
    c.press('data-canvas-save')
    c.type('First draft, and more')
    await c.answer({ canvas: canvas('First draft', 2), revisions: [] })
    expect(c.editor()?.props.value).toBe('First draft, and more')
    // The next save is made from the version just saved, not the one before.
    c.press('data-canvas-save')
    expect(JSON.parse(String(c.asked[0].init?.body))).toMatchObject({ body: 'First draft, and more', baseVersion: 2 })
    await c.answer({ canvas: canvas('First draft, and more', 3), revisions: [] })
    expect(c.editor()).toBeUndefined()
  })

  it('a save still closes the editor when nothing was typed since', async () => {
    const c = await mount()
    c.press('data-canvas-edit')
    c.type('Done')
    c.press('data-canvas-save')
    await c.answer({ canvas: canvas('Done', 2), revisions: [] })
    expect(c.editor()).toBeUndefined()
  })

  it('Save pressed twice, or by the keys, sends once', async () => {
    const c = await mount()
    c.press('data-canvas-edit')
    c.type('Once')
    act(() => {
      c.button('data-canvas-save').props.onClick()
      c.editor().props.onKeyDown({ key: 'Enter', metaKey: true, preventDefault: () => {}, nativeEvent: {} })
    })
    expect(c.asked.filter((a) => a.init?.method === 'PUT')).toHaveLength(1)
    expect(c.button('data-canvas-ai-edit').props.disabled).toBe(true)
  })

  it('an update written from words since changed is offered, not put in their place', async () => {
    const c = await mount()
    c.press('data-canvas-edit')
    c.type('Mine')
    c.press('data-canvas-ai-edit')
    c.type('Mine, typed on')
    await c.answer({ byModel: true, body: 'From the conversation' })
    expect(c.editor().props.value).toBe('Mine, typed on')
    act(() => { c.button('data-suggestion-use').props.onClick() })
    expect(c.editor().props.value).toBe('From the conversation')
  })

  it('an update goes straight in when the words it was written from still stand', async () => {
    const c = await mount()
    c.press('data-canvas-edit')
    c.press('data-canvas-ai-edit')
    await c.answer({ byModel: true, body: 'From the conversation' })
    expect(c.editor().props.value).toBe('From the conversation')
    expect(c.tree.root.findAll((n) => n.props['data-canvas-suggestion'] === '1')).toHaveLength(0)
  })

  it('an edit cancelled and begun again is not closed by the older save', async () => {
    const c = await mount()
    c.press('data-canvas-edit')
    c.type('Old')
    c.press('data-canvas-save')
    c.press('data-canvas-cancel')
    c.press('data-canvas-edit')
    c.type('New edit')
    await c.answer({ canvas: canvas('Old', 2), revisions: [] })
    expect(c.editor().props.value).toBe('New edit')
  })
})
