import React from 'react'
import {act, create} from 'react-test-renderer'
import {afterEach, expect, test, vi} from 'vitest'
import {AgentToolTrace} from './AgentToolTrace'
const chosenLocale = vi.hoisted(() => ({value: 'en'}))
vi.mock('../utils/locale', () => ({getLocale: () => chosenLocale.value}))
vi.mock('../utils/i18n', () => ({useT: () => (text: string) => text}))
const api = {httpBase: 'https://api.example', orgId: 'org', sessionToken: 'one'}
afterEach(() => {vi.unstubAllGlobals(); chosenLocale.value = 'en'})

test('loads safe execution summaries only after disclosure and never renders tool input or output', async () => {
  const fetch = vi.fn().mockResolvedValue({ok: true, json: async () => ({trace: {
    startedAt: '2026-11-07T00:00:00.000Z', finishedAt: '2026-11-07T00:00:01.250Z', elapsedMs: 1250,
    steps: [{name: 'search_records', status: 'completed', elapsedMs: 1250, args: 'private-query', result: 'private-result'}],
    args: 'private-query', result: 'private-result',
  }})})
  vi.stubGlobal('fetch', fetch)
  let tree!: ReturnType<typeof create>
  await act(async () => {tree = create(<AgentToolTrace api={api} channel="b:general" messageId="answer"/>)})
  expect(fetch).not.toHaveBeenCalled()
  const disclosure = tree.root.findByType('details')
  await act(async () => {await disclosure.props.onToggle({currentTarget: {open: true}})})
  expect(fetch.mock.calls[0][0]).toContain('/channels/agent-tool-traces?')
  expect(fetch.mock.calls[0][1].headers).toEqual({'x-session-token': 'one'})
  expect(JSON.stringify(tree.toJSON())).toContain('search_records')
  expect(JSON.stringify(tree.toJSON())).toContain('Completed')
  expect(JSON.stringify(tree.toJSON())).not.toContain('private-query')
  expect(JSON.stringify(tree.toJSON())).not.toContain('private-result')
  act(() => tree.unmount())
})

test('hides the disclosure when the message has no stored trace', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({status: 404, ok: false}))
  let tree!: ReturnType<typeof create>
  await act(async () => {tree = create(<AgentToolTrace api={api} channel="b:general" messageId="answer"/>)})
  const disclosure = tree.root.findByType('details')
  await act(async () => {await disclosure.props.onToggle({currentTarget: {open: true}})})
  expect(tree.toJSON()).toBeNull()
  act(() => tree.unmount())
})
