// One channel: messages from the workspace's Durable Object through the
// shared ChannelSync (packages/core), drawn with FlashList v2.
//
// Also where a link opens (https://app.honmaruai.com/c/<channel>?org=<orgId>,
// see +native-intent.tsx): the link's workspace is switched to when it is
// one of yours; a link to a workspace you are not in says so.

import { FlashList } from '@shopify/flash-list'
import { Stack, useLocalSearchParams } from 'expo-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Animated, AppState, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChannelSync, inConversation, replyStats, splitMentions, threadOf, type ChannelState, type HeldMessage, type ReplyStats } from '@honmaru/core'
import type { Message } from '@honmaru/protocol'
import { useSession } from '../../lib/session'
import { loadDraft, saveDraft } from '../../lib/drafts'

export default function Channel() {
  const { channel, name, org } = useLocalSearchParams<{ channel: string; name?: string; org?: string }>()
  const { api, orgId, me, chooseOrg } = useSession()
  const linkedOrg = typeof org === 'string' && org ? org : null
  const foreign = Boolean(linkedOrg && me && !(me.orgs || []).some((o) => o.id === linkedOrg))
  // Until the link's workspace is the current one, nothing is opened.
  const here = !linkedOrg || foreign ? orgId : (orgId === linkedOrg ? orgId : null)
  useEffect(() => {
    if (linkedOrg && !foreign && me && orgId !== linkedOrg) void chooseOrg(linkedOrg)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedOrg, foreign, me, orgId])
  const sync = useMemo(() => new ChannelSync(api, here || '', channel), [api, here, channel])
  const [state, setState] = useState<ChannelState>(sync.snapshot)
  const [draft, setDraft] = useState('')
  // The thread open over the conversation, by the message it hangs off.
  const [threadId, setThreadId] = useState<string | null>(null)
  // "Also send to #channel" under a thread's box: for the next reply only.
  const [alsoChannel, setAlsoChannel] = useState(false)
  const insets = useSafeAreaInsets()
  // The box's draft: the conversation's, or the open thread's.
  const box = threadId ? `${channel}#thread:${threadId}` : channel
  // What was half-written here is back in the box, and kept as it changes.
  // Nothing is written until what was kept has been read.
  const draftFor = useRef<string | null>(null)
  useEffect(() => {
    draftFor.current = null
    if (!here) return
    const at = `${here}|${box}`
    let live = true
    void loadDraft(here, box).then((kept) => {
      if (!live) return
      draftFor.current = at
      setDraft(kept)
      setAlsoChannel(false)
    })
    return () => { live = false }
  }, [here, box])
  useEffect(() => {
    if (!here || draftFor.current !== `${here}|${box}`) return
    void saveDraft(here, box, draft)
  }, [draft, here, box])
  const shown = useMemo(() => inConversation(state.messages), [state.messages])
  const replies = useMemo(() => replyStats(state.messages), [state.messages])
  const thread = threadId ? threadOf(state.messages, threadId) : null

  useEffect(() => {
    if (!here || foreign) return
    const off = sync.subscribe(setState)
    void sync.open().then(() => sync.markRead())
    // Back to the front: whatever was said meanwhile, and no more.
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') void sync.catchUp().then(() => sync.markRead()) })
    return () => { off(); sub.remove() }
  }, [sync, here, foreign])

  const send = () => {
    const text = draft.trim()
    if (!text) return
    const both = Boolean(threadId) && alsoChannel
    setDraft('')
    setAlsoChannel(false)
    // Not reached, it stays in the conversation, failed, to send again; only
    // words the server refused come back to the box, to change.
    void sync.send(text, me?.login || '', { parentId: threadId, alsoChannel: both }).then(() => sync.markRead())
      .catch((err: { held?: boolean }) => { if (!err?.held) { setDraft(text); setAlsoChannel(both) } })
  }
  // A reply shown in the conversation opens the thread it is in.
  const openThread = (m: Message) => setThreadId(m.parentId || m.id)

  // Newest at the bottom, kept in view as messages arrive (FlashList v2).
  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
      <Stack.Screen options={{ title: thread ? 'Thread' : name ? `# ${name}` : channel }} />
      {thread ? (
        <Pressable onPress={() => setThreadId(null)} style={styles.back} accessibilityRole="button" testID="thread-back">
          <Text style={styles.backText}>‹ {name ? `# ${name}` : 'Back'}</Text>
        </Pressable>
      ) : null}
      {foreign ? <Text style={styles.error}>This link is to a workspace you are not in.</Text> : null}
      <FlashList
        data={thread ? [thread.parent, ...thread.replies] : shown}
        // The key a message was sent under, kept once the server has it, so
        // its row stays and fades up rather than being drawn anew.
        keyExtractor={(m) => m.key || m.id}
        renderItem={({ item }) => (
          <Row
            message={item}
            inThread={Boolean(thread)}
            replies={thread ? undefined : replies.get(item.id)}
            parent={!thread && item.parentId ? state.messages.find((m) => m.id === item.parentId) : undefined}
            onOpenThread={thread ? undefined : () => openThread(item)}
            onRetry={() => { void sync.retry(item.id).then(() => sync.markRead()).catch(() => {}) }}
            onDiscard={() => sync.discard(item.id)}
          />
        )}
        maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 0.2, startRenderingFromBottom: true }}
        onStartReached={() => { if (!thread) void sync.loadOlder() }}
        ListEmptyComponent={state.loading ? null : <Text style={styles.empty}>No messages yet.</Text>}
      />
      {state.error ? <Text style={styles.error}>{state.error}</Text> : null}
      {thread ? (
        <View style={styles.also}>
          <Switch value={alsoChannel} onValueChange={setAlsoChannel} testID="also-channel" accessibilityLabel={name ? `Also send to #${name}` : 'Also send to the conversation'} />
          <Text style={styles.alsoText}>{name ? `Also send to #${name}` : 'Also send to the conversation'}</Text>
        </View>
      ) : null}
      <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        <TextInput style={styles.input} value={draft} onChangeText={setDraft} placeholder={thread ? 'Reply…' : 'Message'} multiline />
        <Pressable onPress={send} disabled={!draft.trim()} style={styles.send}><Text style={styles.sendText}>Send</Text></Pressable>
      </View>
    </KeyboardAvoidingView>
  )
}

const excerpt = (text: string) => {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > 60 ? `${t.slice(0, 59)}…` : t
}

/// One message. In the conversation: a long press opens its thread, "N
/// replies" under it does too, and a reply sent here as well says which
/// thread it answers. In a thread: a reply sent to the conversation says so.
function Row({ message, inThread = false, replies, parent, onOpenThread, onRetry, onDiscard }: {
  message: HeldMessage; inThread?: boolean; replies?: ReplyStats; parent?: Message; onOpenThread?: () => void
  onRetry?: () => void; onDiscard?: () => void
}) {
  // On its way: faded until the server says it has it, then up to full
  // over a moment (#212). Failed: faded, with why and a way to send again.
  const state = message.sending?.state
  const [opacity] = useState(() => new Animated.Value(state ? 0.5 : 1))
  useEffect(() => {
    Animated.timing(opacity, { toValue: state ? 0.5 : 1, duration: state ? 0 : 260, useNativeDriver: true }).start()
  }, [state, opacity])
  return (
    <Animated.View style={{ opacity }}>
    <Pressable onLongPress={state ? undefined : onOpenThread} delayLongPress={350} style={styles.row} accessibilityState={{ busy: state === 'pending' }}>
      {!inThread && message.parentId && message.alsoChannel ? (
        <Pressable onPress={onOpenThread} accessibilityRole="button" testID="thread-reply-line">
          <Text style={styles.threadLine} numberOfLines={1}>↳ Replied to a thread{parent ? `: ${excerpt(parent.body)}` : ''}</Text>
        </Pressable>
      ) : null}
      <Text style={styles.author}>{message.author || 'Someone'}</Text>
      <Text style={styles.body}>
        {message.deletedAt ? <Text style={styles.deleted}>This message was deleted.</Text>
          : splitMentions(message.body).map((part, i) => (
            <Text key={i} style={part.mention ? styles.mention : null}>{part.text}</Text>
          ))}
      </Text>
      {state === 'pending' ? <Text style={styles.sending} testID="message-sending">Sending…</Text> : null}
      {state === 'failed' ? (
        <View style={styles.failedRow}>
          <Text style={styles.failed}>Not sent{message.sending?.error ? ` · ${message.sending.error}` : ''}</Text>
          <Pressable onPress={onRetry} accessibilityRole="button" testID="message-retry"><Text style={styles.failedAction}>Try again</Text></Pressable>
          <Pressable onPress={onDiscard} accessibilityRole="button" testID="message-discard"><Text style={styles.failedAction}>Delete</Text></Pressable>
        </View>
      ) : null}
      {inThread && message.parentId && message.alsoChannel ? <Text style={styles.alsoSent}>Also sent to the conversation</Text> : null}
      {replies && replies.count > 0 ? (
        <Pressable onPress={onOpenThread} accessibilityRole="button" testID="thread-replies">
          <Text style={styles.replies}>{replies.count === 1 ? '1 reply' : `${replies.count} replies`}</Text>
        </Pressable>
      ) : null}
    </Pressable>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  row: { paddingHorizontal: 16, paddingVertical: 8 },
  sending: { color: '#888', fontSize: 12, marginTop: 2 },
  failedRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 },
  failed: { color: '#d1242f', fontSize: 13, flexShrink: 1 },
  failedAction: { color: '#1f6feb', fontWeight: '600', fontSize: 13 },
  author: { fontWeight: '700', fontSize: 15, marginBottom: 2 },
  body: { fontSize: 16, lineHeight: 22 },
  mention: { color: '#1f6feb', fontWeight: '600' },
  deleted: { fontStyle: 'italic', color: '#888' },
  empty: { textAlign: 'center', color: '#888', padding: 32 },
  error: { color: '#d1242f', paddingHorizontal: 16 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 12, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#ccc' },
  input: { flex: 1, minHeight: 40, maxHeight: 140, borderWidth: StyleSheet.hairlineWidth, borderColor: '#999', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16 },
  send: { paddingHorizontal: 12, paddingVertical: 10 },
  sendText: { color: '#1f6feb', fontWeight: '700', fontSize: 16 },
  back: { paddingHorizontal: 16, paddingVertical: 8 },
  backText: { color: '#1f6feb', fontWeight: '600', fontSize: 15 },
  threadLine: { color: '#666', fontSize: 13, marginBottom: 2 },
  replies: { color: '#1f6feb', fontWeight: '600', fontSize: 13, marginTop: 4 },
  alsoSent: { color: '#888', fontSize: 12, marginTop: 2 },
  also: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 6 },
  alsoText: { color: '#444', fontSize: 14 },
})
