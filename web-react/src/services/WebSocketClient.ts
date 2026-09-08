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
  private joined = false
  private pendingCards = new Map<string, { expected: Record<string,unknown>; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  // Grows on each failed retry (2s → 4s → 8s … capped) so a server that is
  // down is not hammered every 2s, and resets to the minimum on a success.
  private reconnectDelay = RECONNECT_MIN_MS

  onStateChange?: (state: AppState) => void
  onCardCreated?: (card: DecisionCard) => void
  onCardUpdated?: (card: DecisionCard) => void
  onCardDeleted?: (cardId: string) => void
  onPresence?: (userId: string, status: string) => void
  onError?: (message: string) => void
  onToolCallResult?: (toolCallId: string, result: any) => void
  onConnectionChange?: (isConnected: boolean) => void
  onAccessDenied?: (message: string) => void

  connect(
    url: string,
    userId: string,
    orgId: string = 'core-team',
    sessionToken?: string
  ): Promise<void> {
    // Detach the previous socket before opening a new one. React StrictMode
    // mounts effects twice; a late close from the old socket must not clear
    // the new connection or schedule a duplicate retry.
    this.disconnect()
    if (this.currentUserId !== userId || this.lastConnectParams?.orgId !== orgId) this.state = { cardsById: {} }
    this.pendingToolCalls = {}
    this.toolCallIdsByCard = {}
    this.intentionalDisconnect = false
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
            resolve()
          } catch (error) {
            reject(error)
          }
        }

        ws.onmessage = (event) => {
          if (this.ws !== ws) return
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

        ws.onclose = (event) => {
          if (this.ws !== ws) return
          this.ws = null
          this.joined = false
          this.rejectPendingCards('Connection lost. Check Sent before retrying your decision.')
          this.onConnectionChange?.(false)
          reject(new Error(event?.reason || 'Connection closed.'))
          if (event?.code === 1008) {
            this.intentionalDisconnect = true
            this.onAccessDenied?.(event.reason || 'Please sign in again to continue.')
          } else this.scheduleReconnect()
        }
      } catch (error) {
        reject(error)
      }
    })
  }

  private scheduleReconnect(): void {
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
    const previous = this.ws
    this.ws = null
    this.joined = false
    if (previous) {
      previous.onopen = null
      previous.onmessage = null
      previous.onerror = null
      previous.onclose = null
      previous.close()
    }
    this.rejectPendingCards('Connection lost. Check Sent before retrying your decision.')
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
        this.rejectPendingCards(json.message || 'The server could not save this decision.')
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
    this.joined = true
    this.onConnectionChange?.(true)
    // New top-level object, not a mutation of the existing one — passing
    // the same reference to a React setState call gets dropped by
    // Object.is, so old cards would never clear (e.g. after clear_store).
    this.state = { ...this.state, cardsById: event.snapshot.cardsById }
    this.confirmPendingCards()
    this.onStateChange?.(this.state)
  }

  private handleDelta(event: StateDelta): void {
    if (!event.delta) return

    try {
      // mutateDocument=false: returns a new object rather than mutating
      // this.state in place, for the same reference-identity reason as
      // handleSnapshot above.
      const result = applyPatch(this.state, event.delta as Operation[], false, false)
      this.state = result.newDocument
      this.confirmPendingCards()
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
        this.confirmPendingCards()
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
  ): boolean {
    if (!this.canSend() || !this.currentUserId) return false

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

    this.ws!.send(JSON.stringify({
      type: 'tool_result',
      payload
    }))
    return true
  }

  sendRollback(cardId: string): boolean {
    if (!this.canSend()) return false

    this.ws!.send(JSON.stringify({
      type: 'rollback',
      payload: { cardId }
    }))
    return true
  }

  // Send a newly created card into the org feed. The relay stamps the sender
  // from the session, persists it, and broadcasts it to every member.
  sendCardCreated(card: { id: string; [key: string]: unknown }): Promise<void> {
    if (!this.canSend()) return Promise.reject(new Error('You are offline. Reconnect before sending.'))
    if (this.pendingCards.has(card.id)) return Promise.reject(new Error('This decision is already being sent.'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCards.delete(card.id)
        reject(new Error('Delivery could not be confirmed. Check Sent before retrying.'))
      }, 15000)
      const expected = Object.fromEntries(['title','summary','context','type','priority','recipientUserID','sourceInstruction','videoURL'].map((field) => [field,card[field]]))
      expected.senderUserID = this.currentUserId
      this.pendingCards.set(card.id, { expected, resolve, reject, timer })
      try {
        this.ws!.send(JSON.stringify({ type: 'card_created', payload: { card } }))
      } catch {
        clearTimeout(timer)
        this.pendingCards.delete(card.id)
        reject(new Error('Could not send. Reconnect and try again.'))
      }
    })
  }

  private canSend(): boolean {
    return this.joined && this.ws?.readyState === WebSocket.OPEN
  }

  private confirmPendingCards(): void {
    for (const [id, pending] of this.pendingCards) {
      const card = this.state.cardsById[id]
      if (!card || !Object.entries(pending.expected).every(([field,value]) => (card as unknown as Record<string,unknown>)[field] === value)) continue
      clearTimeout(pending.timer)
      this.pendingCards.delete(id)
      pending.resolve()
    }
  }

  private rejectPendingCards(message: string): void {
    for (const pending of this.pendingCards.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(message))
    }
    this.pendingCards.clear()
  }

  // File a card under a business (a slug, or a new name), or null to clear.
  // The relay accepts this from the sender or the recipient.
  sendSetBusiness(cardId: string, business: string | null): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({
      type: 'set_business',
      payload: { cardId, business }
    }))
  }

  // Re-alert the recipient of a card you sent that is still pending.
  sendNudge(cardId: string): boolean {
    if (!this.canSend()) return false
    this.ws!.send(JSON.stringify({
      type: 'nudge',
      payload: { cardId }
    }))
    return true
  }

  getState(): AppState {
    return this.state
  }

  getCard(cardId: string): DecisionCard | null {
    return this.state.cardsById[cardId] || null
  }
}
