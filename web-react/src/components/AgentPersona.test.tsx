import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, test, vi } from 'vitest'
import { AgentPersona } from './AgentPersona'
vi.mock('../utils/i18n', () => ({ useT: () => (text: string) => text }))
vi.mock('../utils/markdown', () => ({ Markdown: ({ source }: any) => <p>{source}</p> }))
vi.mock('./Icon', () => ({ Icon: () => null }))
const agent = { id: 'agent', name: 'Atlas', instructions: 'Original persona' }
const props = { agent, httpBase: 'https://example.test', orgId: 'one', sessionToken: 'session', canEdit: true, onUpdated: vi.fn() }
const nodes = () => ({ removeAttribute: vi.fn() })
test('inline persona editing saves only text and its original version, preserving a failed draft', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ message: 'Unavailable' }) })
    .mockResolvedValue({ ok: true, json: async () => ({ agent: { ...agent, instructions: 'New persona' } }) })
  vi.stubGlobal('fetch', fetcher)
  let tree!: ReturnType<typeof create>
  const updated = vi.fn()
  try {
    act(() => { tree = create(<AgentPersona {...props} onUpdated={updated}/>, { createNodeMock: nodes }) })
    act(() => tree.root.findAllByType('button').find(b => b.children.includes('Edit yourself'))!.props.onClick())
    const save = () => tree.root.findAllByType('button').find(b => b.children.includes('Save persona'))!
    expect(save().props.disabled).toBe(true)
    act(() => tree.root.findByType('textarea').props.onChange({ target: { value: 'New persona' } }))
    await act(async () => save().props.onClick())
    expect(tree.root.findByType('textarea').props.value).toBe('New persona')
    expect(tree.root.findByProps({ role: 'alert' }).children).toContain('Unavailable')
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ orgId: 'one', id: 'agent', instructions: 'New persona', expectedInstructions: 'Original persona' })
    await act(async () => save().props.onClick())
    expect(updated).toHaveBeenCalledWith({ ...agent, instructions: 'New persona' })
    expect(tree.root.findAllByType('textarea')).toHaveLength(0)
  } finally { act(() => tree?.unmount()); vi.unstubAllGlobals() }
})
test('a conflict retains the draft until explicit reload and then uses the latest version', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ message: 'Changed elsewhere' }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ agents: [{ ...agent, instructions: 'Someone else’s edit' }] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ agent: { ...agent, instructions: 'Merged edit' } }) })
  vi.stubGlobal('fetch', fetcher)
  let tree!: ReturnType<typeof create>
  try {
    act(() => { tree = create(<AgentPersona {...props}/>, { createNodeMock: nodes }) })
    act(() => tree.root.findAllByType('button').find(b => b.children.includes('Edit yourself'))!.props.onClick())
    const save = () => tree.root.findAllByType('button').find(b => b.children.includes('Save persona'))!
    act(() => tree.root.findByType('textarea').props.onChange({ target: { value: 'My draft' } }))
    await act(async () => save().props.onClick())
    expect(tree.root.findByType('textarea').props.value).toBe('My draft')
    expect(save().props.disabled).toBe(true)
    await act(async () => tree.root.findAllByType('button').find(b => b.children.includes('Discard my draft and reload the latest persona'))!.props.onClick())
    expect(tree.root.findByType('textarea').props.value).toBe('Someone else’s edit')
    act(() => tree.root.findByType('textarea').props.onChange({ target: { value: 'Merged edit' } }))
    await act(async () => save().props.onClick())
    expect(JSON.parse(fetcher.mock.calls[2][1].body).expectedInstructions).toBe('Someone else’s edit')
  } finally { act(() => tree?.unmount()); vi.unstubAllGlobals() }
})
test('read-only members see the persona without editing controls', () => {
  let tree!: ReturnType<typeof create>
  act(() => { tree = create(<AgentPersona {...props} canEdit={false}/>) })
  expect(tree.root.findAllByType('button')).toHaveLength(0)
  expect(JSON.stringify(tree.toJSON())).toContain('Original persona')
  act(() => tree.unmount())
})
