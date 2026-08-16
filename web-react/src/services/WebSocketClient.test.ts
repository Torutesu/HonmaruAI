import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebSocketClient } from './WebSocketClient'

// Minimal WebSocket stand-in: WebSocketClient only touches onopen/onmessage/
// onerror/onclose, send(), close(), and readyState — no need for a real
// socket or a DOM environment to exercise its logic.
class FakeWebSocket {
  static OPEN = 1
  static CLOSED = 3

  readyState = FakeWebSocket.OPEN
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: ((error: unknown) => void) | null = null
  onclose: (() => void) | null = null
  sent: any[] = []

  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(JSON.parse(data))
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.()
  }

  // Test helper: simulate the relay sending a message.
  emit(message: any) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }

  static instances: FakeWebSocket[] = []
  static reset() {
    FakeWebSocket.instances = []
  }
}

beforeEach(() => {
  FakeWebSocket.reset()
  vi.stubGlobal('WebSocket', FakeWebSocket)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function connectedClient(userId = 'user-alice') {
  const client = new WebSocketClient()
  const connectPromise = client.connect('ws://test', userId, 'core-team')
  const socket = FakeWebSocket.instances[0]
  socket.onopen?.()
  await connectPromise
  return { client, socket }
}

describe('WebSocketClient', () => {
  it('sends a join message with the given userId/orgId on connect', async () => {
    const { socket } = await connectedClient('user-alice')
    expect(socket.sent[0]).toEqual({
      type: 'join',
      payload: { userId: 'user-alice', orgId: 'core-team', protocol: 'agui/1' },
    })
  })

  it('STATE_SNAPSHOT replaces state with a new object reference (not a mutation)', async () => {
    const { client, socket } = await connectedClient()
    const states: any[] = []
    client.onStateChange = (s) => states.push(s)

    const before = client.getState()
    socket.emit({ type: 'STATE_SNAPSHOT', snapshot: { cardsById: { c1: { id: 'c1' } } } })

    expect(states).toHaveLength(1)
    // Reference must differ from the pre-snapshot state, or React's
    // setState(newState) would see Object.is(prev, next) === true and skip
    // the re-render entirely — this was silently broken before.
    expect(states[0]).not.toBe(before)
    expect(states[0].cardsById.c1).toEqual({ id: 'c1' })
  })

  it('a request_decision tool call produces a new cardsById object, not a mutated one', async () => {
    const { client, socket } = await connectedClient()
    const states: any[] = []
    client.onStateChange = (s) => states.push(s)

    socket.emit({ type: 'STATE_SNAPSHOT', snapshot: { cardsById: {} } })
    const afterSnapshot = client.getState()

    socket.emit({ type: 'TOOL_CALL_START', toolCallId: 'call-1', toolCallName: 'request_decision' })
    socket.emit({
      type: 'TOOL_CALL_ARGS',
      toolCallId: 'call-1',
      delta: JSON.stringify({ card: { id: 'card-1', recipientUserID: 'user-alice', status: 'pending' } }),
    })
    socket.emit({ type: 'TOOL_CALL_END', toolCallId: 'call-1' })

    const afterToolCall = client.getState()
    expect(afterToolCall).not.toBe(afterSnapshot)
    expect(afterToolCall.cardsById['card-1']).toBeTruthy()
    expect(afterToolCall.cardsById).not.toBe(afterSnapshot.cardsById)
  })

  it('sendDecision attributes the decision to the userId passed to connect(), not localStorage', async () => {
    const { client, socket } = await connectedClient('user-bob')
    socket.emit({ type: 'STATE_SNAPSHOT', snapshot: { cardsById: { 'card-1': { id: 'card-1' } } } })

    client.sendDecision('card-1', 'approve')

    const sent = socket.sent.find((m) => m.type === 'tool_result')
    expect(sent.payload.content.actorUserID).toBe('user-bob')
  })

  it('links a tool_result to the toolCallId from the original request_decision', async () => {
    const { client, socket } = await connectedClient()

    socket.emit({ type: 'TOOL_CALL_START', toolCallId: 'call-42', toolCallName: 'request_decision' })
    socket.emit({
      type: 'TOOL_CALL_ARGS',
      toolCallId: 'call-42',
      delta: JSON.stringify({ card: { id: 'card-1', recipientUserID: 'user-alice', status: 'pending' } }),
    })
    socket.emit({ type: 'TOOL_CALL_END', toolCallId: 'call-42' })

    client.sendDecision('card-1', 'approve')

    const sent = socket.sent.find((m) => m.type === 'tool_result')
    expect(sent.payload.toolCallId).toBe('call-42')
  })

  it('reconnects automatically after an unexpected close, but not after an explicit disconnect()', async () => {
    vi.useFakeTimers()
    const { client, socket } = await connectedClient()
    const connectionEvents: boolean[] = []
    client.onConnectionChange = (connected) => connectionEvents.push(connected)

    // Unexpected close (e.g. relay restart) -> should schedule a reconnect.
    socket.onclose?.()
    expect(connectionEvents).toEqual([false])
    await vi.advanceTimersByTimeAsync(2100)
    expect(FakeWebSocket.instances.length).toBe(2)

    // Explicit disconnect() -> must NOT reconnect.
    client.disconnect()
    await vi.advanceTimersByTimeAsync(5000)
    expect(FakeWebSocket.instances.length).toBe(2)
  })

  it('does not send a decision when not connected', async () => {
    const client = new WebSocketClient()
    // Never connected — sendDecision must no-op, not throw.
    expect(() => client.sendDecision('card-1', 'approve')).not.toThrow()
  })
})
