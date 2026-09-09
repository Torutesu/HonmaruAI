import type { DecisionCard } from '../types/card'

// The fallback router emits identity bookkeeping as context. The sender and
// routing explanation already have dedicated UI, so omit only exact matches
// to these known generated segments and retain all substantive request text.
export function requestContext(card: DecisionCard, context: string): string[] {
  const identities = [card.senderUserID, card.recipientUserID]
  const routeNames = (card.agentRoute || '').split(' → ').map((part) => part.replace(/'s AI$/, ''))
  const knownNames = [...identities, ...routeNames].filter(Boolean)
  const boilerplate = new Set(knownNames.flatMap((name) => [`from ${name}`.toLowerCase(), `decision routed to ${name}`.toLowerCase()]))
  return context.split(/\s+·\s+/).map((segment) => segment.trim()).filter((segment) => segment && !boilerplate.has(segment.toLowerCase()))
}
