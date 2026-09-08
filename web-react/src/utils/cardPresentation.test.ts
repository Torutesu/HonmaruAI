import { describe, it, expect } from 'vitest'
import { requestContext } from './cardPresentation'
import type { DecisionCard } from '../types/card'

const card = { senderUserID: 'u:sender@example.invalid', recipientUserID: 'u:reader@example.invalid', agentRoute: "Sam's AI → Riley's AI" } as DecisionCard

describe('Decision context presentation', () => {
  it('removes duplicated generated identities but keeps request context intact', () => {
    expect(requestContext(card, 'From u:sender@example.invalid · decision routed to u:reader@example.invalid · Budget: $2,400 · Deadline: Friday')).toEqual(['Budget: $2,400', 'Deadline: Friday'])
  })
  it('recognizes names already represented by the AI route', () => {
    expect(requestContext(card, 'From Sam · decision routed to Riley')).toEqual([])
  })
  it('does not discard content merely because it begins with From', () => {
    expect(requestContext(card, 'From the customer: preserve the final deadline · Decision routed to legal for background review')).toEqual(['From the customer: preserve the final deadline', 'Decision routed to legal for background review'])
  })
})
