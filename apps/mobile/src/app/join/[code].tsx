// An invitation link (https://app.honmaruai.com/join/<code>). Signed in: the
// workspace the link opens is named, from the preview that spends nothing,
// and the code is redeemed only when the person taps Join (#960). Any app or
// page can open this link, so opening it is not agreeing to join someone's
// workspace. A 202 means an admin must approve them first: there is no
// membership yet, so the app stays where it is and says so. Signed out: on
// to sign-in with the code, which spends it on the way in.

import { Redirect, router, useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { ApiError } from '@honmaru/core'
import type { InvitePeek } from '@honmaru/protocol'
import { useSession } from '../../lib/session'
import { useWorkspaceColors } from '../../components/WorkspaceMenu'

function useJoinCopy() {
  const { me } = useSession()
  const ja = me?.locale?.startsWith('ja')
  return {
    title: (team: string | null) => team ? (ja ? `${team}に参加しますか？` : `Join ${team}?`) : (ja ? 'このワークスペースに参加しますか？' : 'Join this workspace?'),
    inviter: (name: string) => ja ? `${name}さんがこのワークスペースに招待しました。` : `${name} invited you to this workspace.`,
    hint: ja ? '参加するとこのワークスペースのメンバーになります。' : 'Joining adds you to this workspace.',
    join: ja ? '参加' : 'Join',
    joining: ja ? '参加中…' : 'Joining…',
    cancel: ja ? 'キャンセル' : 'Cancel',
    invalid: ja ? 'この招待は無効か、有効期限が切れています。' : 'This invitation is not valid, or has expired.',
    failed: ja ? 'この招待は使えませんでした。' : 'That invitation could not be used.',
    pending: ja ? 'このワークスペースの管理者による承認が必要です。承認されると参加できます。' : 'An admin of this workspace needs to approve you. You will be let in once they do.',
    back: ja ? 'チャンネルに戻る' : 'Go to your channels',
  }
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'ask'; peek: InvitePeek; joining?: boolean; error?: string }
  | { kind: 'done'; message: string }

export default function Join() {
  const { code } = useLocalSearchParams<{ code: string }>()
  const { api, token, chooseOrg } = useSession()
  const copy = useJoinCopy()
  const c = useWorkspaceColors()
  // Kept with the code it is about, so a second link opened on this screen
  // never shows the first one's workspace over the second one's Join.
  const [state, setState] = useState<{ code: string; phase: Phase } | null>(null)
  const phase: Phase = state && state.code === code ? state.phase : { kind: 'loading' }
  const setPhase = (next: Phase) => setState({ code, phase: next })

  useEffect(() => {
    if (!token || !code) return
    let live = true
    api.peekInvite(code)
      .then((peek) => { if (live) setState({ code, phase: { kind: 'ask', peek } }) })
      .catch(() => { if (live) setState({ code, phase: { kind: 'done', message: copy.invalid } }) })
    return () => { live = false }
    // Once per code and session: `copy` is a new object every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, token, code])

  if (!token) return <Redirect href={{ pathname: '/sign-in', params: { invite: code } }} />

  const join = async (peek: InvitePeek) => {
    if (phase.kind === 'ask' && phase.joining) return
    setPhase({ kind: 'ask', peek, joining: true })
    try {
      const r = await api.acceptInvite(code)
      if (r.pending) { setPhase({ kind: 'done', message: copy.pending }); return }
      await chooseOrg(r.orgId)
      router.replace('/')
    } catch (err) {
      setPhase({ kind: 'ask', peek, error: err instanceof ApiError ? err.message : copy.failed })
    }
  }

  if (phase.kind === 'loading') return <View style={[styles.screen, { backgroundColor: c.bg }]}><ActivityIndicator /></View>
  if (phase.kind === 'done') {
    return (
      <View style={[styles.screen, { backgroundColor: c.bg }]}>
        <Text accessibilityRole="alert" style={[styles.text, { color: c.text }]}>{phase.message}</Text>
        <Pressable accessibilityRole="button" onPress={() => router.replace('/')}><Text style={styles.link}>{copy.back}</Text></Pressable>
      </View>
    )
  }
  const { peek, joining, error } = phase
  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <Text accessibilityRole="header" style={[styles.title, { color: c.text }]}>{copy.title(peek.team)}</Text>
      {peek.inviter ? <Text style={[styles.text, { color: c.text }]}>{copy.inviter(peek.inviter)}</Text> : null}
      <Text style={[styles.hint, { color: c.secondary }]}>{copy.hint}</Text>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      <View style={styles.actions}>
        <Pressable accessibilityRole="button" disabled={joining} onPress={() => router.replace('/')} style={[styles.button, { borderColor: c.border }]}>
          <Text style={[styles.buttonText, { color: c.text }]}>{copy.cancel}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" disabled={joining} onPress={() => void join(peek)} style={[styles.button, styles.primary]}>
          <Text style={[styles.buttonText, styles.primaryText]}>{joining ? copy.joining : copy.join}</Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 16 },
  title: { fontSize: 22, fontWeight: '600', textAlign: 'center' },
  text: { fontSize: 17, textAlign: 'center' },
  hint: { fontSize: 15, textAlign: 'center' },
  error: { fontSize: 15, textAlign: 'center', color: '#d1242f' },
  link: { color: '#1f6feb', fontSize: 17 },
  actions: { flexDirection: 'row', gap: 12 },
  button: { minWidth: 120, paddingVertical: 12, paddingHorizontal: 20, borderRadius: 12, borderWidth: 1, alignItems: 'center' },
  buttonText: { fontSize: 17, fontWeight: '600' },
  primary: { backgroundColor: '#1f6feb', borderColor: '#1f6feb' },
  primaryText: { color: '#fff' },
})
