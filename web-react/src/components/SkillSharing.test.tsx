import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, test, vi } from 'vitest'
import { SkillSharing } from './SkillSharing'
import type { HarnessApi } from '../utils/harness'

vi.mock('../utils/i18n', () => ({ useT: () => (text: string) => text }))
let tree: ReactTestRenderer | undefined
afterEach(() => { act(() => tree?.unmount()); vi.unstubAllGlobals() })

test('requires public-link acknowledgement, creates an expiring link, and revokes it', async () => {
  const share = { id: 'share_1', createdAt: '2026-10-31T00:00:00Z', expiresAt: '2026-11-07T00:00:00Z', revokedAt: null, fileCount: 2, totalBytes: 120 }
  const api = {
    httpBase: 'https://api.example',
    skillShares: vi.fn().mockResolvedValueOnce({ shares: [] }).mockResolvedValueOnce({ shares: [share] }).mockResolvedValueOnce({ shares: [{ ...share, revokedAt: '2026-10-31T01:00:00Z' }] }),
    createSkillShare: vi.fn().mockResolvedValue({ token: `skl_${'ab'.repeat(32)}`, share }),
    revokeSkillShare: vi.fn().mockResolvedValue({ revoked: true }),
  } as unknown as HarnessApi
  const clipboardWrite = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('location', { origin: 'https://app.example' })
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboardWrite } })

  await act(async () => { tree = create(<SkillSharing api={api} skillId="skill_1" />) })
  const createButton = tree!.root.findAllByType('button').find(button => button.children.includes('Create Skill link'))!
  expect(createButton.props.disabled).toBe(true)
  await act(async () => { tree!.root.findByProps({ type: 'checkbox' }).props.onChange({ target: { checked: true } }) })
  const expiry = tree!.root.findByProps({ 'aria-label': 'Skill share expiry' })
  await act(async () => { expiry.props.onChange({ target: { value: '30' } }) })
  await act(async () => { createButton.props.onClick() })
  expect(api.createSkillShare).toHaveBeenCalledWith('skill_1', 30)
  expect(clipboardWrite).toHaveBeenCalledWith(`https://app.example/#/skill-share/${'skl_' + 'ab'.repeat(32)}`)
  expect(tree!.root.findByProps({ 'aria-label': 'Skill share link' }).props.value).toBe(`https://app.example/#/skill-share/${'skl_' + 'ab'.repeat(32)}`)
  expect(tree!.root.findAllByType('a').find(link => link.children.includes('Download ZIP'))!.props.href).toBe(`https://api.example/skill-shares/${'skl_' + 'ab'.repeat(32)}/download`)

  const revoke = tree!.root.findAllByType('button').find(button => button.children.includes('Revoke'))!
  await act(async () => { revoke.props.onClick() })
  expect(api.revokeSkillShare).toHaveBeenCalledWith('skill_1', 'share_1')
  expect(tree!.root.findAllByType('button').some(button => button.children.includes('Revoke'))).toBe(false)
})
