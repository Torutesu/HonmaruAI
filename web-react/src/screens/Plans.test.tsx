import React from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, test, vi } from 'vitest'
import { Plans } from './Plans'

vi.mock('../utils/i18n', () => ({ useT: () => (text: string, vars?: Record<string, string | number>) => Object.entries(vars || {}).reduce((value, [key, replacement]) => value.replaceAll(`{${key}}`, String(replacement)), text) }))
afterEach(() => vi.unstubAllGlobals())

const base = {
  plan: 'pro', pro: true, purchasable: true, accessSource: 'subscription', workspaceKey: false,
  complimentary: false, complimentarySyncPending: false, complimentaryAvailable: false,
  dailyLimit: 3, usedToday: 0, remainingToday: null,
}

async function mount(subscription: object) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...base, subscription })))
  let tree!: ReturnType<typeof create>
  await act(async () => { tree = create(<Plans httpBase="https://api.example" sessionToken="session" onClose={vi.fn()} />) })
  return tree
}

test('shows the live trial period without claiming the App Store renewal has been cancelled', async () => {
  const tree = await mount({ periodType: 'trial', expiresAt: '2099-02-03T04:05:06Z', purchaseDate: null, cancellationDetectedAt: null, billingIssueDetectedAt: null, gracePeriodExpiresAt: null, sandbox: false })
  const rendered = JSON.stringify(tree.toJSON())
  expect(rendered).toContain('Your free trial is active through')
  expect(rendered).toContain(new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date('2099-02-03T04:05:06Z')))
  expect(rendered).not.toContain('Cancellation was detected')
  act(() => tree.unmount())
})

test('shows cancellation and billing issues while retaining the authoritative active access state', async () => {
  const tree = await mount({ periodType: 'normal', expiresAt: '2099-02-03T04:05:06Z', purchaseDate: null, cancellationDetectedAt: '2099-02-01T00:00:00Z', billingIssueDetectedAt: '2099-02-02T00:00:00Z', gracePeriodExpiresAt: '2099-02-04T00:00:00Z', sandbox: false })
  const rendered = JSON.stringify(tree.toJSON())
  expect(rendered).toContain('Cancellation was detected. Pro access remains active through')
  expect(rendered).toContain('The App Store reported a billing issue.')
  expect(rendered).toContain('Billing grace period through')
  expect(rendered).toContain('Manage or cancel your subscription in iPhone Settings')
  act(() => tree.unmount())
})
