import { describe, expect, it } from 'vitest'
import { isWorkspaceBudgetNoticeContextCurrent, shouldRestoreWorkspaceBudgetNotice, workspaceBudgetNoticeDismissalKey } from './workspaceBudgetNotice'

const reached = { action: 'pause', periods: { '24h': { limitMicros: 5_000_000, exhausted: true } } }

describe('shouldRestoreWorkspaceBudgetNotice', () => {
  it('restores for an editable Harness workspace with an exhausted pause budget', () => {
    expect(shouldRestoreWorkspaceBudgetNotice({ workspaceMode: 'harness', canEdit: true, aiBudget: reached })).toBe(true)
  })

  it('restores when the configured limit is indeterminate', () => {
    expect(shouldRestoreWorkspaceBudgetNotice({ workspaceMode: 'harness', canEdit: true, aiBudget: {
      action: 'pause', periods: { '7d': { limitMicros: 2_000_000, indeterminate: true } },
    } })).toBe(true)
  })

  it.each([
    ['Simple mode', { workspaceMode: 'harness', simpleOnly: true, canEdit: true, aiBudget: reached }],
    ['non-Harness mode', { workspaceMode: 'simple', canEdit: true, aiBudget: reached }],
    ['read-only member', { workspaceMode: 'harness', canEdit: false, aiBudget: reached }],
    ['warn policy', { workspaceMode: 'harness', canEdit: true, aiBudget: { ...reached, action: 'warn' } }],
    ['unreached limit', { workspaceMode: 'harness', canEdit: true, aiBudget: { action: 'pause', periods: { '24h': { limitMicros: 5_000_000 } } } }],
    ['disabled limit', { workspaceMode: 'harness', canEdit: true, aiBudget: { action: 'pause', periods: { '24h': { limitMicros: 0, exhausted: true } } } }],
  ])('does not restore for %s', (_name, input) => {
    expect(shouldRestoreWorkspaceBudgetNotice(input as Parameters<typeof shouldRestoreWorkspaceBudgetNotice>[0])).toBe(false)
  })
})

describe('isWorkspaceBudgetNoticeContextCurrent', () => {
  const current = {
    request: 2, latestRequest: 2, expectedScope: 'host/org/user/session', currentScope: 'host/org/user/session',
    workspaceMode: 'harness', simpleOnly: false, workspaceModeLoaded: true,
  }

  it('accepts the latest request in the same Harness session and org', () => {
    expect(isWorkspaceBudgetNoticeContextCurrent(current)).toBe(true)
  })

  it.each([
    ['an older request after resync', { ...current, request: 1 }],
    ['an org or session switch', { ...current, currentScope: 'host/other-org/user/new-session' }],
    ['Simple mode', { ...current, simpleOnly: true }],
    ['an unresolved workspace mode', { ...current, workspaceModeLoaded: false }],
  ])('rejects %s', (_name, input) => {
    expect(isWorkspaceBudgetNoticeContextCurrent(input)).toBe(false)
  })
})

describe('workspaceBudgetNoticeDismissalKey', () => {
  it('keeps a dismissal for one revision but permits the next budget revision to notify', () => {
    const dismissed = workspaceBudgetNoticeDismissalKey('host/org/user/session', 3)
    expect(workspaceBudgetNoticeDismissalKey('host/org/user/session', 3)).toBe(dismissed)
    expect(workspaceBudgetNoticeDismissalKey('host/org/user/session', 4)).not.toBe(dismissed)
  })
})
