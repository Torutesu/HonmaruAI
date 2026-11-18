import React from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { SlackDraftCard } from './SlackDraftCard'

const record = (extra: Record<string, unknown> = {}) => ({
  id: 'draft-1', text: 'Hello team', revision: 1, status: 'pending',
  agent: { id: 'agent-1', name: 'Writer' }, target: { channelId: 'C123', label: 'Slack channel ID' },
  ...extra,
})
const response = (draft: unknown) => ({ ok: true, json: async () => ({ draft }) })
const targetsResponse = { ok: true, json: async () => ({ targets: [
  { channelId: 'C123', name: 'general', type: 'channel', private: false, groupDm: false },
  { channelId: 'C456', name: 'launch', type: 'channel', private: false, groupDm: false },
] }) }
const props = { httpBase: 'https://api.example', orgId: 'org-1', sessionToken: 'session', draftId: 'draft-1', conversation: 'ag:agent-1|me' }
afterEach(() => vi.unstubAllGlobals())

it('loads the saved target read-only and only sends after an explicit Send action', async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(response(record()))
    .mockResolvedValueOnce(targetsResponse)
    .mockResolvedValueOnce(response(record({ text: 'Hello everyone', revision: 2 })))
    .mockResolvedValueOnce(response(record({ text: 'Hello everyone', revision: 2, status: 'sent' })))
  vi.stubGlobal('fetch', fetcher)
  let tree!: ReturnType<typeof create>
  await act(async () => { tree = create(<SlackDraftCard {...props} />) })
  expect(tree.root.findAllByType('p').some(node => node.children.join('').includes('Slack destination: general (C123)'))).toBe(true)
  expect(tree.root.findByProps({ 'aria-label': 'Verified Slack destination' }).props.value).toBe('C123')
  expect(tree.root.findByType('textarea').props.value).toBe('Hello team')
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(fetcher.mock.calls[0][0]).toBe('https://api.example/channels/slack-drafts/draft-1?orgId=org-1&conversation=ag%3Aagent-1%7Cme')

  await act(async () => { tree.root.findByType('textarea').props.onChange({ currentTarget: { value: 'Hello everyone' } }) })
  expect(fetcher).toHaveBeenCalledTimes(2)
  await act(async () => { tree.root.findAllByType('button').find(button => button.children.join('') === 'Save draft')!.props.onClick() })
  expect(fetcher).toHaveBeenCalledTimes(3)
  expect(fetcher.mock.calls[2][1]).toMatchObject({ method: 'PUT' })
  expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({ orgId: 'org-1', conversation: 'ag:agent-1|me', revision: 1, text: 'Hello everyone' })

  expect(fetcher.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
  await act(async () => { tree.root.findAllByType('button').find(button => button.children.join('') === 'Send')!.props.onClick() })
  expect(fetcher).toHaveBeenCalledTimes(4)
  expect(fetcher.mock.calls[3][0]).toBe('https://api.example/channels/slack-drafts/draft-1/send')
  expect(fetcher.mock.calls[3][1]).toMatchObject({ method: 'POST' })
  expect(JSON.parse(fetcher.mock.calls[3][1].body)).toEqual({ orgId: 'org-1', conversation: 'ag:agent-1|me', revision: 2 })
  expect(tree.root.findByProps({ role: 'status' }).children.join('')).toBe('Sent to Slack.')
})

it('does not offer resend for an unknown provider outcome', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(record({ status: 'unknown' }))))
  let tree!: ReturnType<typeof create>
  await act(async () => { tree = create(<SlackDraftCard {...props} />) })
  expect(tree.root.findByProps({ role: 'alert' }).children.join('')).toContain('Slack did not confirm whether this message was sent.')
  expect(tree.root.findAllByType('button').some(button => button.children.join('') === 'Send')).toBe(false)
  expect(tree.root.findAllByType('textarea')).toHaveLength(0)
})

it('clears an ambiguous send error when reload confirms the draft was sent', async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(response(record()))
    .mockResolvedValueOnce(targetsResponse)
    .mockResolvedValueOnce({ ok: false, json: async () => ({ message: 'The send response was interrupted.' }) })
    .mockResolvedValueOnce(response(record({ status: 'sent', revision: 1 })))
  vi.stubGlobal('fetch', fetcher)
  let tree!: ReturnType<typeof create>
  await act(async () => { tree = create(<SlackDraftCard {...props} />) })
  await act(async () => { tree.root.findAllByType('button').find(button => button.children.join('') === 'Send')!.props.onClick() })
  expect(tree.root.findAllByProps({ role: 'alert' }).some(node => node.children.join('').includes('send response was interrupted'))).toBe(false)
  expect(tree.root.findAllByProps({ role: 'status' }).some(node => node.children.join('').includes('Sent to Slack.'))).toBe(true)
})

it('saves a human-selected verified destination with the current revision before sending', async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(response(record()))
    .mockResolvedValueOnce(targetsResponse)
    .mockResolvedValueOnce(response(record({ revision: 2, target: { channelId: 'C456', name: 'launch', verified: true } })))
  vi.stubGlobal('fetch', fetcher)
  let tree!: ReturnType<typeof create>
  await act(async () => { tree = create(<SlackDraftCard {...props} />) })
  await act(async () => { tree.root.findByProps({ 'aria-label': 'Verified Slack destination' }).props.onChange({ currentTarget: { value: 'C456' } }) })
  expect(tree.root.findAllByType('button').find(button => button.children.join('') === 'Send')!.props.disabled).toBe(true)
  await act(async () => { tree.root.findAllByType('button').find(button => button.children.join('') === 'Save draft')!.props.onClick() })
  expect(fetcher.mock.calls[2][1]).toMatchObject({ method: 'PUT' })
  expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({ orgId: 'org-1', conversation: 'ag:agent-1|me', revision: 1, text: 'Hello team', targetChannelId: 'C456' })
  expect(tree.root.findByProps({ 'aria-label': 'Verified Slack destination' }).props.value).toBe('C456')
})

it('requires a separate, explicit acknowledgement before a DLP warning can be sent', async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(response(record()))
    .mockResolvedValueOnce(targetsResponse)
    .mockResolvedValueOnce({ ok: false, json: async () => ({ code: 'dlp-warning', message: 'This looks like it contains a protected value. Send it anyway?' }) })
    .mockResolvedValueOnce(response(record({ status: 'sent' })))
  vi.stubGlobal('fetch', fetcher)
  let tree!: ReturnType<typeof create>
  await act(async () => { tree = create(<SlackDraftCard {...props} />) })
  await act(async () => { tree.root.findAllByType('button').find(button => button.children.join('') === 'Send')!.props.onClick() })
  expect(fetcher).toHaveBeenCalledTimes(3)
  expect(JSON.parse(fetcher.mock.calls[2][1].body)).not.toHaveProperty('dlpAck')
  expect(JSON.stringify(tree.toJSON())).toContain('Send it anyway?')
  expect(tree.root.findAllByType('button').find(button => button.children.join('') === 'Send anyway')).toBeTruthy()
  await act(async () => { tree.root.findAllByType('button').find(button => button.children.join('') === 'Send anyway')!.props.onClick() })
  expect(fetcher).toHaveBeenCalledTimes(4)
  expect(JSON.parse(fetcher.mock.calls[3][1].body)).toMatchObject({ dlpAck: true, revision: 1 })
})
