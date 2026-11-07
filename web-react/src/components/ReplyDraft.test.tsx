import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, test, vi } from 'vitest'
import { ReplyDraft } from './ReplyDraft'

vi.mock('../utils/i18n', () => ({ useT: () => (text: string) => text }))
vi.mock('../utils/locale', () => ({ getLocale: () => 'en' }))
vi.mock('../utils/aiKey', () => ({ aiHeaders: () => ({}) }))

const card: any = { id: 'card-1', sourceApp: 'Gmail', recipientUserID: 'me', senderUserID: 'them', decision: { action: 'approve' } }
const props = { httpBase: 'https://api.test', orgId: 'workspace', sessionToken: 'session', card }

test('explicitly remembers edited style without sending the reply', async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ draft: 'Hello, this is the original draft.\n\nBest regards.' }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ learned: [{ key: 'concise' }] }) })
  vi.stubGlobal('fetch', fetcher)
  let tree!: ReturnType<typeof create>
  try {
    await act(async () => { tree = create(<ReplyDraft {...props} />) })
    await act(async () => tree.root.findAllByType('button').find((b) => b.children.includes('Draft the reply'))!.props.onClick())
    const area = tree.root.findByType('textarea')
    act(() => area.props.onChange({ target: { value: 'Short reply.' } }))
    const remember = tree.root.findAllByType('button').find((b) => b.children.includes('Remember my edits'))!
    await act(async () => remember.props.onClick())
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[1][0]).toBe('https://api.test/ai/draft-preferences')
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ orgId: 'workspace', cardId: 'card-1', original: 'Hello, this is the original draft.\n\nBest regards.', revised: 'Short reply.' })
    expect(JSON.stringify(tree.toJSON())).toContain('Style preference saved for your drafts in this workspace. The draft was not sent.')
  } finally { act(() => tree?.unmount()); vi.unstubAllGlobals() }
})

test('shares only changed Agent draft text with that Agent after edit and offers discard', async () => {
  const agentCard = { ...card, sourceAgentId: 'agent-1', sourceDetail: 'Writer' }
  const fetcher = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ queued: false }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ draft: 'Hello team, here is the long update.' }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ queued: true }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ removed: 1 }) })
  vi.stubGlobal('fetch', fetcher)
  let tree!: ReturnType<typeof create>
  try {
    await act(async () => { tree = create(<ReplyDraft {...props} card={agentCard} />) })
    await act(async () => tree.root.findAllByType('button').find((b) => b.children.includes('Draft the reply'))!.props.onClick())
    const area = tree.root.findByType('textarea')
    act(() => area.props.onChange({ target: { value: 'Team, short update.' } }))
    await act(async () => area.props.onBlur())
    expect(fetcher.mock.calls[2][0]).toContain('/ai/draft-edits')
    expect(JSON.parse(fetcher.mock.calls[2][1].body)).toMatchObject({ cardId: 'card-1', original: 'Hello team, here is the long update.', revised: 'Team, short update.' })
    expect(tree.root.findAllByType('p').some((p) => p.children.join('').includes('Your next message to {agent} will include these edits'))).toBe(true)
    await act(async () => tree.root.findAllByType('button').find((b) => b.children.includes('Discard queued edits'))!.props.onClick())
    expect(fetcher.mock.calls[3][1].method).toBe('DELETE')
    expect(fetcher.mock.calls.some((call) => String(call[0]).includes('/reply'))).toBe(false)
  } finally {
    vi.unstubAllGlobals()
  }
})

test('restores the queued-edit review and discard control after reopening the card', async () => {
  const agentCard = { ...card, sourceAgentId: 'agent-1', sourceDetail: 'Writer' }
  const fetcher = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ queued: true }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ removed: 1 }) })
  vi.stubGlobal('fetch', fetcher)
  let tree!: ReturnType<typeof create>
  try {
    await act(async () => { tree = create(<ReplyDraft {...props} card={agentCard} />) })
    expect(JSON.stringify(tree.toJSON())).toContain('Your next message to {agent} will include these edits')
    await act(async () => tree.root.findAllByType('button').find((b) => b.children.includes('Discard queued edits'))!.props.onClick())
    expect(fetcher.mock.calls[1][1].method).toBe('DELETE')
  } finally {
    vi.unstubAllGlobals()
  }
})
