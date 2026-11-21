import { describe, expect, it, vi } from 'vitest'
import { hashForApp } from '../utils/route'
import { openAppActivityPush } from './DashboardPushNavigation'

describe('Dashboard app activity push navigation', () => {
  it('brings the app forward and opens the exact record conversation', () => {
    const bringForward = vi.fn(), closePanel = vi.fn(), navigate = vi.fn()
    const handled = openAppActivityPush({ type: 'open-app-activity', appId: 'tasks', orgId: 'team:one', tableId: 'orders', rowId: 'row-7' }, { bringForward, closePanel, navigate })
    expect(handled).toBe(true)
    expect(bringForward).toHaveBeenCalledOnce()
    expect(closePanel).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledWith(hashForApp('tasks', 'team:one', { tableId: 'orders', rowId: 'row-7' }))
  })

  it('opens app-level activity without claiming a record scope', () => {
    const bringForward = vi.fn(), closePanel = vi.fn(), navigate = vi.fn()
    expect(openAppActivityPush({ type: 'open-app-activity', appId: 'tasks', orgId: 'team:one' }, { bringForward, closePanel, navigate })).toBe(true)
    expect(navigate).toHaveBeenCalledWith(hashForApp('tasks', 'team:one'))
  })

  it('ignores other events and malformed or partial record scopes', () => {
    const actions = { bringForward: vi.fn(), closePanel: vi.fn(), navigate: vi.fn() }
    expect(openAppActivityPush({ type: 'open-card', appId: 'tasks', orgId: 'team:one' } as never, actions)).toBe(false)
    expect(openAppActivityPush({ type: 'open-app-activity', appId: 'tasks', orgId: 'team:one', rowId: 'row-7' }, actions)).toBe(false)
    expect(openAppActivityPush({ type: 'open-app-activity', appId: 'tasks', orgId: 'bad workspace' }, actions)).toBe(false)
    expect(actions.bringForward).not.toHaveBeenCalled()
    expect(actions.closePanel).not.toHaveBeenCalled()
    expect(actions.navigate).not.toHaveBeenCalled()
  })
})
