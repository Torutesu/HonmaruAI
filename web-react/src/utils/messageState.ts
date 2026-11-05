import type { ChannelMessage } from '../types/card'

/// A delayed response can be newer about one part of a message and older
/// about another. Content edits/deletes, thread titles and pins each have
/// their own server version, so merge those fields independently.
export function reconcileMessage(previous: ChannelMessage | undefined, next: ChannelMessage): ChannelMessage {
  if (!previous || previous.id !== next.id) return next

  const previousContentVersion = Number(previous.contentVersion || 0)
  const nextContentVersion = Number(next.contentVersion || 0)
  const legacyContentIsNewer = (previous.editedAt || '') > (next.editedAt || '')
  const keepContent = previous.deleted === true || (!next.deleted && (
    previousContentVersion > nextContentVersion ||
    (previousContentVersion === nextContentVersion && (previous.editPending || legacyContentIsNewer))
  ))

  const previousPinVersion = Number(previous.pinVersion || 0)
  const nextPinVersion = Number(next.pinVersion || 0)
  const keepPin = !next.deleted && previousPinVersion > nextPinVersion
  const previousTitleVersion = Number(previous.threadTitleVersion || 0)
  const nextTitleVersion = Number(next.threadTitleVersion || 0)
  const keepTitle = !next.deleted && previousTitleVersion > nextTitleVersion

  if (!keepContent && !keepPin && !keepTitle) return next

  return {
    ...next,
    ...(keepContent ? {
      body: previous.body,
      lang: previous.lang,
      editedAt: previous.editedAt,
      contentVersion: previous.contentVersion,
      files: previous.files,
      cardId: previous.cardId ?? next.cardId,
      ...(previous.deleted ? { deleted: true, body: '', files: [], cardId: null, pinned: false } : {}),
      ...(previous.editPending ? { editPending: true } : { editPending: next.editPending }),
    } : {}),
    ...(keepPin ? { pinned: previous.pinned, pinVersion: previous.pinVersion } : {}),
    ...(keepTitle ? {
      threadTitle: previous.threadTitle,
      threadTitleVersion: previous.threadTitleVersion,
      canRenameThread: previous.canRenameThread ?? next.canRenameThread,
    } : {}),
  }
}
