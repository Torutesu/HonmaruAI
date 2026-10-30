import { describe, expect, it } from 'vitest'
import { conversationScope } from '../../../apps/mobile/src/lib/conversationScope'

describe('mobile linked conversation scope', () => {
  const memberOfA = [{ id: 'A' }]
  const memberOfBoth = [{ id: 'A' }, { id: 'B' }]
  it('never borrows A for an inaccessible B link with the same channel id', () => {
    expect(conversationScope('A', 'B', memberOfA)).toBeNull()
    expect(conversationScope('B', 'B', memberOfA)).toBeNull()
  })
  it('requires confirmed membership and completed workspace selection', () => {
    expect(conversationScope('A', 'B', memberOfBoth)).toBeNull()
    expect(conversationScope(null, 'B', memberOfBoth)).toBeNull()
    expect(conversationScope('B', 'B', undefined)).toBeNull()
    expect(conversationScope('B', 'B', memberOfBoth)).toBe('B')
  })
  it('keeps failed switches unavailable and follows rapid route changes', () => {
    const routeChanges = [
      conversationScope('A', 'B', memberOfBoth),
      conversationScope('B', 'A', memberOfBoth),
      conversationScope('B', 'B', memberOfBoth),
      conversationScope('B', 'forbidden', memberOfBoth),
    ]
    expect(routeChanges).toEqual([null, null, 'B', null])
  })
  it('retains selected-workspace behavior for links without org', () => {
    expect(conversationScope('A', null, undefined)).toBe('A')
    expect(conversationScope(null, null, memberOfA)).toBeNull()
  })
})
