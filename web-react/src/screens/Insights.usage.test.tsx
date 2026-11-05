import React from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, test, vi } from 'vitest'
import { Insights } from './Insights'

vi.mock('../utils/i18n', () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) =>
    key.replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name] ?? `{${name}}`)),
}))

afterEach(() => vi.unstubAllGlobals())

test('AI usage chart switches between daily and cumulative deployment-key estimates', async () => {
  const today = Date.now()
  const daily = Array.from({ length: 30 }, (_, index) => ({
    day: new Date(today - (29 - index) * 86400000).toISOString().slice(0, 10),
    calls: index >= 28 ? 1 : 0,
    ourUsd: index >= 28 ? 0.25 : 0,
    byokUsd: 0,
    usd: index >= 28 ? 0.25 : 0,
  }))
  const cardDays = daily.slice(-14).map(({ day }) => ({ day, count: 0 }))
  const metrics = {
    days: 14, cards: 0, pending: 0, decided: 0, selfAddressed: 0,
    medianMinutesToDecide: null, declineRate: null, nudges: 0,
    created: cardDays, bySource: [], byAction: [],
    feedback: { right: 0, wrong: 0, reasons: {} },
    ai: { calls: 2, inputTokens: 10, outputTokens: 5, usd: 0.5, ourUsd: 0.5, byokCalls: 0, days: 30, daily, byPurpose: [], byProvider: [], jevShare: null },
  }
  const fetchStub = vi.fn(async () => ({ ok: true, json: async () => metrics }))
  vi.stubGlobal('fetch', fetchStub)
  let tree!: ReturnType<typeof create>
  await act(async () => {
    tree = create(<Insights httpBase="https://synthetic.invalid" orgId="org" sessionToken="session" onClose={vi.fn()} />)
  })

  const chart = () => tree.root.findByProps({ role: 'img', 'aria-label': 'Workspace-key AI spend per day over the last 30 days' })
  const bars = () => chart().findAllByProps({ className: 'bar' })
  expect(bars().slice(-2).map((bar) => bar.findByType('i').props.style.height)).toEqual(['100%', '100%'])
  await act(async () => {
    tree.root.findAllByType('button').find((button) => button.children.join('') === '90 days')!.props.onClick()
  })
  expect(fetchStub).toHaveBeenLastCalledWith(expect.stringContaining('&aiDays=90'), expect.objectContaining({ headers: { 'x-session-token': 'session' } }))

  await act(async () => {
    tree.root.findAllByType('button').find((button) => button.children.join('') === 'Cumulative')!.props.onClick()
  })
  expect(tree.root.findAllByProps({ role: 'tab', 'aria-selected': true }).some((tab) => tab.children.join('') === 'Cumulative')).toBe(true)
  expect(bars().slice(-2).map((bar) => bar.findByType('i').props.style.height)).toEqual(['50%', '100%'])
  act(() => tree.unmount())
})
