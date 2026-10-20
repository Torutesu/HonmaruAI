import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, test, vi } from 'vitest'
import { RoomResponses } from './RoomResponses'
vi.mock('../utils/i18n', () => ({ useT: () => (text: string) => text }))
vi.mock('../utils/harness', () => ({ useWorkspaceMode: () => ({ mode: 'harness' }) }))
test('room response switch retains saved state when a conflicting update fails', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ responses: { mentionedOnly: false, version: 3 } }) })
    .mockResolvedValueOnce({ ok: false, json: async () => ({ message: 'The response setting changed. Reload before saving.' }) })
  vi.stubGlobal('fetch', fetcher)
  let tree!: ReturnType<typeof create>
  try {
    await act(async () => { tree = create(<RoomResponses httpBase="https://example.test" orgId="one" headers={{ 'x-session-token': 'token' }} view="b:ops"/>) })
    expect(tree.root.findByType('input').props.checked).toBe(false)
    await act(async () => tree.root.findByType('input').props.onChange({ target: { checked: true } }))
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ orgId: 'one', channel: 'b:ops', mentionedOnly: true, version: 3 })
    expect(tree.root.findByType('input').props.checked).toBe(false)
    expect(tree.root.findByProps({ role: 'alert' }).children[0]).toBe('The response setting changed. Reload before saving.')
  } finally { act(() => tree?.unmount()); vi.unstubAllGlobals() }
})
