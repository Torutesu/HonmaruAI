import type { DecisionCard } from './card'

export interface AGUIEvent {
  type: string
  [key: string]: any
}

export interface StateSnapshot extends AGUIEvent {
  type: 'STATE_SNAPSHOT'
  snapshot: {
    cardsById: Record<string, DecisionCard>
    [key: string]: any
  }
}

export interface StateDelta extends AGUIEvent {
  type: 'STATE_DELTA'
  delta: Array<{
    op: 'add' | 'replace' | 'remove'
    path: string
    value?: any
  }>
}

export interface ToolCallStart extends AGUIEvent {
  type: 'TOOL_CALL_START'
  toolCallId: string
  toolCallName: string
}

export interface ToolCallArgs extends AGUIEvent {
  type: 'TOOL_CALL_ARGS'
  toolCallId: string
  delta: string
}

export interface ToolCallEnd extends AGUIEvent {
  type: 'TOOL_CALL_END'
  toolCallId: string
}

export interface ToolCallResult extends AGUIEvent {
  type: 'TOOL_CALL_RESULT'
  toolCallId: string
  payload: {
    content: {
      cardId: string
      action: string
      actorUserID: string
      decidedAt: string
      optionId?: string
      note?: string
      replyText?: string
    }
  }
}

export interface CustomEvent extends AGUIEvent {
  type: 'CUSTOM'
  name: string
  value: any
}

export interface RunStarted extends AGUIEvent {
  type: 'RUN_STARTED'
}

export interface RunFinished extends AGUIEvent {
  type: 'RUN_FINISHED'
}

export interface RunError extends AGUIEvent {
  type: 'RUN_ERROR'
  message: string
}

export type AnyAGUIEvent =
  | StateSnapshot
  | StateDelta
  | ToolCallStart
  | ToolCallArgs
  | ToolCallEnd
  | ToolCallResult
  | CustomEvent
  | RunStarted
  | RunFinished
  | RunError
