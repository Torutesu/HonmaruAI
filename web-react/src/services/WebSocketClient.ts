import { applyPatch, type Operation } from 'fast-json-patch'
import type { StateSnapshot, StateDelta, ToolCallResult } from '../types/agui'
import type { AppState, DecisionCard } from '../types/card'

const RECONNECT_MIN_MS = 2000
const RECONNECT_MAX_MS = 30000

export class WebSocketClient {
  private ws: WebSocket | null = null
  private state: AppState = { cardsById: {} }
  private pendingToolCalls: Record<string, { name: string; args: string }> = {}
  private toolCallIdsByCard: Record<string, string> = {}

  // Set at connect() time and used for every subsequent send/reconnect —
  // not read from localStorage per-call, which could silently diverge from
  // whichever user this socket actually joined as.
  private currentUserId: string | null = null
  private lastConnectParams: { url: string; orgId: string; sessionToken?: string } | null = null
  private intentionalDisconnect = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  // Grows on each failed retry (2s → 4s → 8s … capped) so a server that is
  // down is not hammered every 2s, and resets to the minimum on a success.
  private reconnectDelay = RECONNECT_MIN_MS
  // Set when the relay closes with 1008. It means "you are not allowed in",
  // not "the network died", and reconnecting to it is a loop that can only
  // ever end the same way.
  private refused = false
  private refusal: { message: string; code?: string } | null = null
  // What this browser tried to send while the socket was down. A decision
  // made on a train used to vanish: sendDecision returned early when the
  // socket was not open and nothing said so, so the card stayed on the
  // screen looking undecided and the person swiped it again — or did not,
  // and the sender waited for an answer that had been given. Held here, in
  // order, and delivered once the relay has accepted the next join.
  private outbox: Array<{ type: string; payload: unknown }> = []
  // True once the relay has answered a join with its snapshot on the current
  // socket. Sending before that point is refused by the relay — it closes the
  // socket — so the outbox waits for it rather than for `onopen`.
  private joined = false

  onStateChange?: (state: AppState) => void
  onCardCreated?: (card: DecisionCard) => void
  onCardUpdated?: (card: DecisionCard) => void
  onCardDeleted?: (cardId: string) => void
  onPresence?: (userId: string, status: string) => void
  onError?: (message: string) => void
  /// The relay refused this socket and will refuse the next one too. `code` is
  /// the machine-readable reason — `not-a-member`, `sign-in-required`,
  /// `client-too-old` — and retrying is not the answer to any of them.
  onRefused?: (message: string, code?: string) => void
  onToolCallResult?: (toolCallId: string, result: any) => void
  onConnectionChange?: (isConnected: boolean) => void
  /// The relay has accepted this socket and sent everything it knows. Until
  /// this fires the feed has nothing to show — not "nothing", nothing yet.
  onSynced?: () => void
  /// How many messages are waiting for the relay to come back. Zero means
  /// everything this browser did has reached it.
  onOutboxChange?: (pending: number) => void

  connect(
    url: string,
    userId: string,
    orgId: string = 'core-team',
    sessionToken?: string
  ): Promise<void> {
    this.intentionalDisconnect = false
    // A fresh connect is a fresh verdict: joining a different workspace after
    // being refused by one must not inherit the refusal.
    this.refused = false
    this.refusal = null
    this.joined = false
    this.currentUserId = userId
    this.lastConnectParams = { url, orgId, sessionToken }

    return new Promise((resolve, reject) => {
      try {
        // The relay reads orgId from the URL query string, not the join
        // payload. Without it the server falls back to the "core-team" demo
        // org and rejects everyone else as "not a member".
        const wsUrl = new URL(url)
        wsUrl.searchParams.set('orgId', orgId)
        const ws = new WebSocket(wsUrl.toString())
        this.ws = ws

        ws.onopen = () => {
          try {
            const joinPayload = {
              type: 'join',
              payload: {
                userId,
                orgId,
                protocol: 'agui/1',
                ...(sessionToken && { sessionToken })
              }
            }
            ws.send(JSON.stringify(joinPayload))
            this.onConnectionChange?.(true)
            resolve()
          } catch (error) {
            reject(error)
          }
        }

        ws.onmessage = (event) => {
          try {
            const json = JSON.parse(event.data)
            this.handleEvent(json)
          } catch (error) {
            console.error('Failed to parse message:', error)
          }
        }

        ws.onerror = (error) => {
          reject(error)
        }

        // The event is optional here on purpose. A browser always supplies a
        // CloseEvent, but this handler is also called directly — by tests, and
        // by any harness standing in for a socket — and a close handler that
        // throws on a missing argument turns a disconnect into an unhandled
        // error instead of a reconnect.
        ws.onclose = (event?: { code?: number; reason?: string }) => {
          this.ws = null
          this.joined = false
          this.onConnectionChange?.(false)
          // 1008 is the relay saying the door will not open: not a member, no
          // valid session, a client too old to speak to it. It sends that code
          // precisely so this is distinguishable from a dead network — and
          // until now nothing here read it, so being removed from a workspace
          // meant a browser retrying, forever, against a refusal.
          if (event?.code === 1008) {
            this.refused = true
            const said = this.refusal || { message: event?.reason || 'This workspace is no longer open to you.' }
            this.onRefused?.(said.message, said.code)
            return
          }
          this.scheduleReconnect()
        }
      } catch (error) {
        reject(error)
      }
    })
  }

  private scheduleReconnect(): void {
    if (this.refused) return
    if (this.intentionalDisconnect || !this.lastConnectParams || !this.currentUserId) return
    if (this.reconnectTimer) return // already scheduled

    const { url, orgId, sessionToken } = this.lastConnectParams
    const userId = this.currentUserId
    const delay = this.reconnectDelay
    // Next attempt waits longer, up to the cap.
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect(url, userId, orgId, sessionToken).catch(() => {
        // onclose (fired by the failed attempt) schedules the next retry —
        // nothing further to do here.
      })
    }, delay)
  }

  disconnect(): void {
    this.intentionalDisconnect = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  private handleEvent(json: any): void {
    const type = json.type as string

    switch (type) {
      case 'STATE_SNAPSHOT':
        this.handleSnapshot(json as StateSnapshot)
        break
      case 'STATE_DELTA':
        this.handleDelta(json as StateDelta)
        break
      case 'TOOL_CALL_START':
        this.handleToolCallStart(json)
        break
      case 'TOOL_CALL_ARGS':
        this.handleToolCallArgs(json)
        break
      case 'TOOL_CALL_END':
        this.handleToolCallEnd(json)
        break
      case 'TOOL_CALL_RESULT':
        this.handleToolCallResult(json as ToolCallResult)
        break
      case 'CUSTOM':
        this.handleCustom(json)
        break
      case 'RUN_ERROR':
        // Held, not acted on: the refusal arrives just before the close, and
        // the close is what says whether this was fatal.
        this.refusal = { message: json.message, code: json.code }
        this.onError?.(json.message)
        break
      default:
        // Ignore unknown event types
        break
    }
  }

  private handleSnapshot(event: StateSnapshot): void {
    if (!event.snapshot?.cardsById) return
    // A successful join resets the backoff, so the next disconnect retries
    // quickly rather than inheriting a long delay from an earlier outage.
    this.reconnectDelay = RECONNECT_MIN_MS
    // New top-level object, not a mutation of the existing one — passing
    // the same reference to a React setState call gets dropped by
    // Object.is, so old cards would never clear (e.g. after clear_store).
    this.state = { ...this.state, cardsById: event.snapshot.cardsById }
    this.onStateChange?.(this.state)
    if (!this.joined) {
      this.joined = true
      this.onSynced?.()
      this.flushOutbox()
    }
  }

  /// Send now if the relay will take it, otherwise keep it for when it will.
  private post(message: { type: string; payload: unknown }): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.joined) {
      this.ws.send(JSON.stringify(message))
      return
    }
    this.outbox.push(message)
    this.onOutboxChange?.(this.outbox.length)
  }

  private flushOutbox(): void {
    if (this.outbox.length === 0) return
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const queued = this.outbox
    this.outbox = []
    for (const message of queued) this.ws.send(JSON.stringify(message))
    this.onOutboxChange?.(0)
  }

  /// Messages this browser has not been able to deliver yet.
  get pendingCount(): number {
    return this.outbox.length
  }

  private handleDelta(event: StateDelta): void {
    if (!event.delta) return

    try {
      // mutateDocument=false: returns a new object rather than mutating
      // this.state in place, for the same reference-identity reason as
      // handleSnapshot above.
      const result = applyPatch(this.state, event.delta as Operation[], false, false)
      this.state = result.newDocument
      this.onStateChange?.(this.state)

      // Extract card operations for detailed callbacks
      for (const operation of event.delta) {
        if (!operation.path?.startsWith('/cardsById/')) continue

        const cardId = this.extractCardId(operation.path)
        if (!cardId) continue

        switch (operation.op) {
          case 'add':
          case 'replace': {
            const card = this.state.cardsById[cardId]
            if (card) {
              operation.op === 'add'
                ? this.onCardCreated?.(card)
                : this.onCardUpdated?.(card)
            }
            break
          }
          case 'remove':
            this.onCardDeleted?.(cardId)
            break
        }
      }
    } catch (error) {
      console.error('Failed to apply patch:', error)
    }
  }

  private handleToolCallStart(event: any): void {
    const id = event.toolCallId as string
    const name = event.toolCallName as string
    if (id && name) {
      this.pendingToolCalls[id] = { name, args: '' }
    }
  }

  private handleToolCallArgs(event: any): void {
    const id = event.toolCallId as string
    const chunk = event.delta as string
    if (id && this.pendingToolCalls[id]) {
      this.pendingToolCalls[id].args += chunk
    }
  }

  private handleToolCallEnd(event: any): void {
    const id = event.toolCallId as string
    if (!id || !this.pendingToolCalls[id]) return

    const { name, args } = this.pendingToolCalls[id]
    delete this.pendingToolCalls[id]

    if (name !== 'request_decision') return

    try {
      const parsed = JSON.parse(args)
      const card = parsed.card as DecisionCard

      if (card?.id) {
        this.toolCallIdsByCard[card.id] = id
        // Same reference-identity concern as handleSnapshot/handleDelta.
        this.state = { ...this.state, cardsById: { ...this.state.cardsById, [card.id]: card } }
        this.onCardCreated?.(card)
        this.onStateChange?.(this.state)
      }
    } catch (error) {
      console.error('Failed to parse tool call args:', error)
    }
  }

  private handleToolCallResult(event: ToolCallResult): void {
    const toolCallId = event.toolCallId
    this.onToolCallResult?.(toolCallId, event.payload?.content)
  }

  private handleCustom(event: any): void {
    if (event.name === 'presence' && event.value) {
      this.onPresence?.(event.value.userId, event.value.status)
    }
  }

  private extractCardId(path: string): string | null {
    const match = path.match(/\/cardsById\/([^/]+)/)
    if (!match?.[1]) return null

    const escaped = match[1]
    return escaped
      .replace(/~1/g, '/')
      .replace(/~0/g, '~')
  }

  sendDecision(
    cardId: string,
    action: string,
    options?: {
      optionId?: string
      replyText?: string
      note?: string
    }
  ): void {
    if (!this.currentUserId) return

    const toolCallId = this.toolCallIdsByCard[cardId]
    const content = {
      cardId,
      action,
      actorUserID: this.currentUserId,
      decidedAt: new Date().toISOString(),
      ...options
    }

    const payload: any = { content }
    if (toolCallId) {
      payload.toolCallId = toolCallId
    }

    this.post({ type: 'tool_result', payload })
  }

  sendRollback(cardId: string): void {
    this.post({ type: 'rollback', payload: { cardId } })
  }

  // Send a newly created card into the org feed. The relay stamps the sender
  // from the session, persists it, and broadcasts it to every member.
  sendCardCreated(card: any): void {
    this.post({ type: 'card_created', payload: { card } })
  }

  // File a card under a business (a slug, or a new name), or null to clear.
  // The relay accepts this from the sender or the recipient.
  sendSetBusiness(cardId: string, business: string | null): void {
    this.post({ type: 'set_business', payload: { cardId, business } })
  }

  // Re-alert the recipient of a card you sent that is still pending.
  sendNudge(cardId: string): void {
    this.post({ type: 'nudge', payload: { cardId } })
  }

  getState(): AppState {
    return this.state
  }

  getCard(cardId: string): DecisionCard | null {
    return this.state.cardsById[cardId] || null
  }
}
