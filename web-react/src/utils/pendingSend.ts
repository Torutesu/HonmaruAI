import type { ChannelMessage, FileRef } from '../types/card'

// Sending as Discord does: what you write is in the conversation the moment
// you press Enter, under an id of its own ("tmp-…") and marked as on its way,
// until the server's copy takes its place. One that does not go stays where
// it was, marked, with why — to send again or throw away. The words are
// never lost to a bad connection.
//
// The server's copy comes two ways, in either order: the answer to the send,
// and the live event the socket brings everyone. Whichever comes first takes
// the place of ours; the other finds it already there.

const TEMP = 'tmp-'

/// Held only on this device, under a temporary id: on its way, or failed.
export const isTemp = (m: Pick<ChannelMessage, 'id'>) => m.id.startsWith(TEMP)

/// How a message held only here is drawn: on its way, or did not go.
export const tempState = (m: ChannelMessage): 'pending' | 'failed' | undefined =>
  m.failed ? 'failed' : m.pending ? 'pending' : undefined

/// When a message sent now is drawn: now — or, with this device's clock
/// behind the server's, just after the newest message held, so what you
/// send never lands above what is already there while it goes.
export function sendTime(list: ChannelMessage[] | undefined, now = new Date()): Date {
  const newest = (list || []).reduce((n, m) => Math.max(n, Date.parse(m.createdAt) || 0), 0)
  return new Date(Math.max(now.getTime(), newest + 1))
}

/// Ours, as it will look once the server has it: written by you, now.
export function tempMessage(
  said: { channel: string; body: string; parentId?: string | null; files?: FileRef[] },
  you: { name: string | null; ref: string | null; avatar?: string | null },
  now = new Date(),
  random = () => Math.random().toString(36).slice(2, 10),
): ChannelMessage {
  return {
    id: `${TEMP}${now.getTime().toString(36)}-${random()}`,
    channel: said.channel,
    kind: 'message',
    body: said.body,
    authorName: you.name,
    authorRef: you.ref,
    authorAvatar: you.avatar ?? null,
    mine: true,
    cardId: null,
    createdAt: now.toISOString(),
    parentId: said.parentId ?? null,
    ...(said.files?.length ? { files: said.files } : {}),
    pending: true,
  }
}

/// The server's copy in place of ours, where ours was. When the socket
/// brought it first, ours just goes and the copy already shown stays — it
/// may be newer (a reaction, the card it became). When ours is gone (a
/// thread reopened, say), the server's copy still shows: it was sent.
export function reconcile(list: ChannelMessage[], tempId: string, real: ChannelMessage): ChannelMessage[] {
  if (list.some((x) => x.id === real.id)) return list.some((x) => x.id === tempId) ? list.filter((x) => x.id !== tempId) : list
  if (list.some((x) => x.id === tempId)) return list.map((x) => (x.id === tempId ? real : x))
  return [...list, real]
}

/// The answer to the send: the server's copy is drawn under the temporary
/// id it takes the place of (`drawn`: server id → key), so the element
/// carries on — while ours is still in `list` and nothing else is drawn
/// under that id already. The same words from another of your devices may
/// have been taken for ours and put in its place; two messages under one
/// key would be one too many.
export function drawUnder(drawn: Map<string, string>, realId: string, tempId: string, list: ChannelMessage[]): void {
  if (!list.some((x) => x.id === tempId)) return
  for (const [id, key] of drawn) if (key === tempId && id !== realId) return
  drawn.set(realId, tempId)
}

/// It did not go: kept where it was, with why — `refused` when the server
/// said no to the words themselves, so it is edited, not sent again.
export const markFailed = (list: ChannelMessage[], tempId: string, why: string, refused = false): ChannelMessage[] =>
  list.map((x) => (x.id === tempId ? { ...x, pending: false, failed: why, refused: refused || undefined } : x))

/// Sent again: on its way once more.
export const markPending = (list: ChannelMessage[], tempId: string): ChannelMessage[] =>
  list.map((x) => (x.id === tempId ? { ...x, pending: true, failed: undefined, refused: undefined } : x))

/// How soon the same words to the same place again are taken for the same
/// press, not a second message.
export const DOUBLE_SEND_MS = 1000

/// A second Enter or a double tap before the box has cleared: the same
/// words (`key`) to the same place within DOUBLE_SEND_MS of the last time.
/// Said again after that on purpose — "ok", "+1" — they go again, even with
/// the first still on its way. A send that goes ahead is noted in `recent`.
export function isDoubleSend(recent: Map<string, number>, key: string, now = Date.now(), within = DOUBLE_SEND_MS): boolean {
  for (const [k, at] of recent) if (now - at >= within) recent.delete(k)
  if (recent.has(key)) return true
  recent.set(key, now)
  return false
}

/// How long a send is given before it is taken for lost: room for a slow
/// network and for a data rule reading an attached file, and short enough
/// that what was sent after it in the same conversation is not held up.
export const SEND_TIMEOUT = 25_000

/// Give up on a send — abort it — once `ms` have gone by without an answer.
/// While `paused` (a question put to the person that the request waits on,
/// such as a data rule's "send it anyway?") the clock stands still, and it
/// starts again from the top once the question is answered. Returns what
/// stops the clock when the answer comes.
export function sendDeadline(ctrl: AbortController, ms = SEND_TIMEOUT, paused: () => boolean = () => false, every = 500): () => void {
  let left = ms
  const id = setInterval(() => {
    if (paused()) { left = ms; return }
    left -= every
    if (left <= 0) { clearInterval(id); ctrl.abort() }
  }, every)
  return () => clearInterval(id)
}

/// An answer that sending the same words again would only meet again: the
/// server read them and said no — a data rule (422, or 409 once "send it
/// anyway" was declined), a thread that has gone (400, 404), no right to
/// post there (403). Not a request that took too long (408), too many at
/// once (429), or a sign-in that ran out (401: signing in again is the
/// answer, and then the same words go): those, like a dropped connection or
/// a server that fell over, Retry can get past.
export const refusedOutright = (status: number) => status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429

const words = (s: string) => s.replace(/\r\n/g, '\n').trim()
const fileIds = (m: ChannelMessage) => (m.files || []).map((f) => f.id).sort().join(',')

/// The server's copy of something of ours still held here: the same words,
/// files and thread, as first sent. The server keeps the words trimmed.
const sameAs = (held: ChannelMessage, real: ChannelMessage) => isTemp(held)
  && !real.editedAt && !real.deleted
  && (held.parentId || null) === (real.parentId || null)
  && words(held.body) === words(real.body)
  && fileIds(held) === fileIds(real)

/// Which of ours still held here a message the socket brought is the
/// server's copy of — none when it is already held, or not ours. One on its
/// way before one that failed with the same words: that one was sent again.
export const echoOf = (list: ChannelMessage[], msg: ChannelMessage): ChannelMessage | undefined =>
  msg.mine && !list.some((x) => x.id === msg.id)
    ? list.find((x) => x.pending && sameAs(x, msg)) || list.find((x) => sameAs(x, msg))
    : undefined

/// A message the socket brought. The copy already held changes in place;
/// our own words still held here take the server's copy where they are, so
/// the socket beating the answer to the send never shows them twice; any
/// other message is new, at the end.
export function arrive(list: ChannelMessage[], msg: ChannelMessage): ChannelMessage[] {
  if (list.some((x) => x.id === msg.id)) return list.map((x) => (x.id === msg.id ? msg : x))
  const held = echoOf(list, msg)
  return held ? list.map((x) => (x === held ? msg : x)) : [...list, msg]
}

/// A fresh copy from the server, with what is still held only here kept at
/// the end: a reload never drops a message on its way, or one that did not
/// go and is waiting to be sent again.
export function keepTemps(fresh: ChannelMessage[], held: ChannelMessage[] | undefined): ChannelMessage[] {
  const ours = (held || []).filter(isTemp)
  return ours.length ? [...fresh, ...ours] : fresh
}

/// A thread read again while it is open. `before`: the ids of the replies
/// drawn when the read left. The answer was the server's thread as it stood
/// then, so a reply that came over the socket since, and is not in it, stays
/// — and one taken away here since stays away; what is held only here is
/// kept at the end, as keepTemps does. Without anything held here it is the
/// answer as it came.
export function refreshedReplies(fresh: ChannelMessage[], held: ChannelMessage[] | undefined, before: ReadonlySet<string>): ChannelMessage[] {
  if (!held?.length) return fresh
  const now = new Set(held.map((x) => x.id))
  const got = new Set(fresh.map((x) => x.id))
  const kept = fresh.filter((x) => !before.has(x.id) || now.has(x.id))
  const since = held.filter((x) => !isTemp(x) && !before.has(x.id) && !got.has(x.id))
  return keepTemps(kept.length === fresh.length && !since.length ? fresh : [...kept, ...since], held)
}

/// Ours not drawn in `list` yet, at the end — each once, however often asked.
export function withHeld(list: ChannelMessage[], held: ChannelMessage[]): ChannelMessage[] {
  const more = held.filter((h) => !list.some((x) => x.id === h.id))
  return more.length ? [...list, ...more] : list
}

// Kept in this browser, per workspace and per person, so that closing the
// tab or reloading never loses what did not go: each message on its way or
// failed, as it was drawn, with how it was sent and, when it failed, why.

export type Unsent = { said: ChannelMessage; decide: boolean; failed?: string; refused?: boolean }

/// Where one person's outbox in one workspace is kept. Per person as well:
/// kept per workspace only, whoever signed in to it next in this browser
/// would have the last person's unsent messages drawn as their own — and
/// Retry would send them under the new name, a direct message included.
/// Each part is encoded, so no workspace and person make another pair's
/// key — and, the ':' in a workspace's id (team:…) encoded, nor the key
/// the whole workspace's was kept under before (sharedOutboxKey).
export const outboxKey = (orgId: string, userId: string) => `outbox:${encodeURIComponent(orgId)}:${encodeURIComponent(userId)}`

/// Where the outbox was kept before it was kept per person: anyone who used
/// the workspace in this browser may have written it.
export const sharedOutboxKey = (orgId: string) => `outbox:${orgId}`

/// Whether one kept under your key can be taken for yours: not when it
/// names someone else as its author. One sent before the team had loaded
/// names nobody, and so does `you` until it has: then the key decides.
export const keptAsYours = (said: Pick<ChannelMessage, 'authorRef'>, you: string | null | undefined) =>
  !you || !said.authorRef || said.authorRef === you

/// Whether one kept for the whole workspace (sharedOutboxKey) is yours:
/// only when it names you as its author. Anything else may be somebody
/// else's, and nothing tells it apart.
export const provenYours = (said: Pick<ChannelMessage, 'authorRef'>, you: string | null | undefined) =>
  !!you && said.authorRef === you

const isUnsent = (u: unknown): u is Unsent => {
  const said = (u as Unsent | null)?.said
  return !!said && typeof said.id === 'string' && isTemp(said) && typeof said.channel === 'string'
    && typeof said.body === 'string' && typeof said.createdAt === 'string'
}

/// What was kept, read back; anything unreadable is left out.
export function readUnsent(raw: string | null): Unsent[] {
  try {
    const list: unknown = JSON.parse(raw || '[]')
    return Array.isArray(list) ? list.filter(isUnsent) : []
  } catch {
    return []
  }
}

/// What to keep once this tab's outbox (`now`) has changed. `ours` is every
/// message this tab has sent or done something with, gone since or not:
/// those are kept as this tab has them now, so one it has sent or thrown
/// away is not brought back from what another tab wrote before. Any other
/// is left as it is kept — another tab's, and one this tab only brought
/// back from before it loaded: gone from what is kept, another tab has sent
/// it or thrown it away since, and it is not written back.
export const keptUnsent = (stored: Unsent[], now: Unsent[], ours: Set<string>): Unsent[] =>
  [...stored.filter((u) => !ours.has(u.said.id)), ...now.filter((u) => ours.has(u.said.id))]

/// A message kept from before this page loaded, as it comes back: failed —
/// on its way when the page went, it may or may not have got there — with
/// why, where it was, to send again or throw away.
export const unsentAgain = (u: Unsent, why: string): ChannelMessage =>
  ({ ...u.said, pending: false, failed: u.failed || why, refused: u.refused || undefined })

/// The server's copy of one still held here, when a fresh page has it.
/// The same words, files and thread, written no more than `skew` before
/// ours was (the two clocks differ). Kept tight, so an earlier "ok" is not
/// taken for a later one that did not go.
export function landedCopy(held: ChannelMessage, fresh: ChannelMessage[], skew = 5000): ChannelMessage | undefined {
  const from = Date.parse(held.createdAt) - skew
  return fresh.find((m) => m.mine && sameAs(held, m) && Date.parse(m.createdAt) >= from)
}

/// Whether one kept from before this page loaded got there after all: the
/// server has one of yours with the same words, files and thread, written
/// no more than `skew` before ours was (the two clocks differ). Kept tight,
/// so an earlier "ok" is not taken for a later one that did not go.
export function wentAfterAll(held: ChannelMessage, fresh: ChannelMessage[], skew = 5000): boolean {
  return Boolean(landedCopy(held, fresh, skew))
}

/// This person's unsent messages, and nobody else's. Sign-out drops them
/// even when another tab has already switched the browser to someone else.
export function forgetOwnOutbox(storage: { length: number; key(index: number): string | null; removeItem(key: string): void }, userId: string) {
  const suffix = `:${encodeURIComponent(userId)}`
  for (let i = storage.length - 1; i >= 0; i--) {
    const key = storage.key(i)
    if (key && key.startsWith('outbox:') && key.endsWith(suffix)) storage.removeItem(key)
  }
}
