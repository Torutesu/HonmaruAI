import { applyPatch, type Operation } from 'fast-json-patch'
import type { AnyAGUIEvent, StateSnapshot, StateDelta, ToolCallResult } from '../types/agui'
import type { AppState, DecisionCard } from '../types/card'

export class WebSocketClient {
  private ws: WebSocket | null = null
  private state: AppState = { cardsById: {} }
  private pendingToolCalls: Record<string, { name: string; args: string }> = {}
  private toolCallIdsByCard: Record<string, string> = {}

  onStateChange?: (state: AppState) => void
  onCardCreated?: (card: DecisionCard) => void
  onCardUpdated?: (card: DecisionCard) => void
  onCardDeleted?: (cardId: string) => void
  onPresence?: (userId: string, status: string) => void
  onError?: (message: string) => void
  onToolCallResult?: (toolCallId: string, result: any) => void

  connect(
    url: string,
    userId: string,
    orgId: string = 'core-team',
    sessionToken?: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(url)

        this.ws.onopen = () => {
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
            this.ws!.send(JSON.stringify(joinPayload))
            resolve()
          } catch (error) {
            reject(error)
          }
        }

        this.ws.onmessage = (event) => {
          try {
            const json = JSON.parse(event.data)
            this.handleEvent(json)
          } catch (error) {
            console.error('Failed to parse message:', error)
          }
        }

        this.ws.onerror = (error) => {
          reject(error)
        }

        this.ws.onclose = () => {
          this.ws = null
        }
      } catch (error) {
        reject(error)
      }
    })
  }

  disconnect(): void {
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
        this.onError?.(json.message)
        break
      default:
        // Ignore unknown event types
        break
    }
  }

  private handleSnapshot(event: StateSnapshot): void {
    if (event.snapshot?.cardsById) {
      this.state.cardsById = event.snapshot.cardsById
      this.onStateChange?.(this.state)
    }
  }

  private handleDelta(event: StateDelta): void {
    if (!event.delta) return

    try {
      // mutateDocument=false: returns a new object rather than mutating
      // this.state in place. Mutating in place would leave the reference
      // passed to React's setState unchanged, so Object.is would see no
      // difference and the update would be silently dropped.
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
          case 'replace':
            const card = this.state.cardsById[cardId]
            if (card) {
              operation.op === 'add'
                ? this.onCardCreated?.(card)
                : this.onCardUpdated?.(card)
            }
            break
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
        this.state.cardsById[card.id] = card
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
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

    const toolCallId = this.toolCallIdsByCard[cardId]
    const content = {
      cardId,
      action,
      actorUserID: this.getCurrentUserId(),
      decidedAt: new Date().toISOString(),
      ...options
    }

    const payload: any = { content }
    if (toolCallId) {
      payload.toolCallId = toolCallId
    }

    this.ws.send(JSON.stringify({
      type: 'tool_result',
      payload
    }))
  }

  sendRollback(cardId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

    this.ws.send(JSON.stringify({
      type: 'rollback',
      payload: { cardId }
    }))
  }

  getState(): AppState {
    return this.state
  }

  getCard(cardId: string): DecisionCard | null {
    return this.state.cardsById[cardId] || null
  }

  private getCurrentUserId(): string {
    return localStorage.getItem('userId') || 'anonymous'
  }
}
