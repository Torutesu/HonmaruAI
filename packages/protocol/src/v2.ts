// The /v2 API: conversations served from a workspace's own Durable Object
// (worker/src/workspace/v2.js). One definition for the Worker's answers and
// every client that reads them.

export interface Message {
  id: string
  channel: string
  /// Per channel, starting at 1, no gaps: what a client asks "after".
  seq: number
  author: string | null
  kind: string
  body: string
  parentId: string | null
  /// A thread reply sent to the conversation as well ("Also send to
  /// #channel"): shown in its thread and in the conversation.
  alsoChannel?: boolean
  createdAt: string
  editedAt: string | null
  deletedAt: string | null
}

export interface HistoryResponse { messages: Message[]; lastSeq: number }
export interface PostResponse { message: Message }
export interface UnreadChannel { channel: string; lastSeq: number; readSeq: number; unread: number }
export interface UnreadResponse { channels: UnreadChannel[] }
export interface SearchResponse { hits: Message[] }
export interface ErrorResponse { message: string }

export interface HistoryQuery { before?: number; after?: number; limit?: number }

export const v2Paths = {
  messages: (orgId: string, channel: string) => `/v2/w/${encodeURIComponent(orgId)}/channels/${encodeURIComponent(channel)}/messages`,
  read: (orgId: string, channel: string) => `/v2/w/${encodeURIComponent(orgId)}/channels/${encodeURIComponent(channel)}/read`,
  unread: (orgId: string) => `/v2/w/${encodeURIComponent(orgId)}/unread`,
  search: (orgId: string) => `/v2/w/${encodeURIComponent(orgId)}/search`,
}
