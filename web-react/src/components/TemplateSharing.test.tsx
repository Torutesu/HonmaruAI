import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, test, vi } from 'vitest'
import { TemplateSharing } from './TemplateSharing'
import type { HarnessApi } from '../utils/harness'

vi.mock('../utils/i18n', () => ({ useT: () => (text: string) => text }))
let tree: ReactTestRenderer | undefined
afterEach(() => { act(() => tree?.unmount()); vi.unstubAllGlobals() })

test('creates a version-pinned expiring link and can revoke it', async () => {
  const share = { id: 'share_1', appVersion: 2, createdAt: '2026-10-31T00:00:00Z', expiresAt: '2026-11-07T00:00:00Z', revokedAt: null }
  const api = {
    templateShares: vi.fn().mockResolvedValueOnce({ canManage: true, shares: [] }).mockResolvedValueOnce({ canManage: true, shares: [share] }).mockResolvedValueOnce({ canManage: true, shares: [{ ...share, revokedAt: '2026-10-31T01:00:00Z' }] }),
    versions: vi.fn().mockResolvedValue({ versions: [{ version: 3, note: 'Current', createdAt: '2026-10-31T00:00:00Z' }, { version: 2, note: null, createdAt: '2026-10-30T00:00:00Z' }] }),
    createTemplateShare: vi.fn().mockResolvedValue({ token: 'tpl_' + 'ab'.repeat(32), share }),
    revokeTemplateShare: vi.fn().mockResolvedValue({ revoked: true }),
  } as unknown as HarnessApi
  vi.stubGlobal('location', { origin: 'https://app.example' })
  await act(async () => { tree = create(<TemplateSharing api={api} appId="app_1" appVersion={3} />) })
  const version = tree!.root.findByProps({ 'aria-label': 'Template version' })
  await act(async () => { version.props.onChange({ target: { value: '2' } }) })
  const createButton = tree!.root.findAllByType('button').find(button => button.children.includes('Create template link'))!
  expect(createButton.props.disabled).toBe(true)
  await act(async () => { tree!.root.findByProps({ type: 'checkbox' }).props.onChange({ target: { checked: true } }) })
  await act(async () => { createButton.props.onClick() })
  expect(api.createTemplateShare).toHaveBeenCalledWith('app_1', 2, 7)
  expect(tree!.root.findByProps({ 'aria-label': 'Template link' }).props.value).toBe(`https://app.example/#/template-share/${'tpl_' + 'ab'.repeat(32)}`)

  const revoke = tree!.root.findAllByType('button').find(button => button.children.includes('Revoke'))!
  await act(async () => { revoke.props.onClick() })
  expect(api.revokeTemplateShare).toHaveBeenCalledWith('app_1', 'share_1')
})
