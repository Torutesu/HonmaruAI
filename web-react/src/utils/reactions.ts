// A reaction, toggled here the moment it is pressed (#221): yours added (a
// new pill, or one more on a pill already there) or taken back (one fewer,
// the pill gone at none). The server's copy replaces it when it answers —
// or the socket's, whichever comes first — and a failure toggles it back.

export interface ReactionPill { emoji: string; count: number; refs: string[]; mine: boolean }

export function toggleReaction(list: ReactionPill[] | undefined, emoji: string, me: string | null | undefined): ReactionPill[] {
  const pills = list || []
  const at = pills.findIndex((r) => r.emoji === emoji)
  if (at < 0) return [...pills, { emoji, count: 1, refs: me ? [me] : [], mine: true }]
  const r = pills[at]
  const next = r.mine
    ? { ...r, mine: false, count: r.count - 1, refs: r.refs.filter((x) => x !== me) }
    : { ...r, mine: true, count: r.count + 1, refs: me && !r.refs.includes(me) ? [...r.refs, me] : r.refs }
  return next.count > 0 ? pills.map((x, i) => (i === at ? next : x)) : pills.filter((_, i) => i !== at)
}
