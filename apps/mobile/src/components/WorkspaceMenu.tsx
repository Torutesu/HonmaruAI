import { router, useFocusEffect } from 'expo-router'
import { useCallback, useState } from 'react'
import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, useColorScheme, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { Me } from '@honmaru/protocol'
import { useSession } from '../lib/session'

export type Workspace = NonNullable<Me['orgs']>[number]
export const workspaceName = (w: Workspace | undefined, fallback: string) => w?.name || (w?.id.includes('/') ? w.id : fallback)
export function useWorkspaceCopy() {
  const { me } = useSession()
  const ja = me?.locale?.startsWith('ja')
  return { name: ja ? 'ワークスペース' : 'Workspace', settings: ja ? 'ワークスペース設定' : 'Workspace settings', add: ja ? 'ワークスペースを追加' : 'Add a workspace', signOut: ja ? 'サインアウト' : 'Sign out', close: ja ? '閉じる' : 'Close', create: ja ? '新しいワークスペースを作成' : 'Create a new workspace', join: ja ? '招待で参加' : 'Join with an invitation', save: ja ? '保存' : 'Save', code: ja ? '招待リンクまたはコード' : 'Invitation link or code', pending: ja ? '管理者の承認をお待ちください。' : 'Waiting for approval from an admin.' }
}
export function useWorkspaceColors() {
  return useColorScheme() === 'dark' ? { bg: '#222529', text: '#f2f2f2', secondary: '#b6b8bb', border: '#3b3d40' } : { bg: '#fff', text: '#202124', secondary: '#61656a', border: '#dedfe1' }
}
export function WorkspaceIdentity({ workspace, fallback }: { workspace?: Workspace; fallback: string }) {
  const c = useWorkspaceColors()
  const name = workspaceName(workspace, fallback)
  return <View style={styles.identity}>
    {workspace?.icon ? <Image source={{ uri: workspace.icon }} style={styles.icon} accessibilityIgnoresInvertColors /> : <View style={[styles.icon, styles.letter, { backgroundColor: c.text }]}><Text style={{ color: c.bg, fontSize: 22, fontWeight: '700' }}>{name[0]?.toUpperCase()}</Text></View>}
    <View style={{ flex: 1 }}><Text style={[styles.name, { color: c.text }]} numberOfLines={2}>{name}</Text><Text style={{ color: c.secondary, fontSize: 13 }}>{workspace?.memberCount != null ? `${workspace.memberCount} ${fallback === 'ワークスペース' ? '人のメンバー' : 'members'}` : fallback}</Text></View>
  </View>
}
export function WorkspaceMenu() {
  const { api, me, orgId, chooseOrg, signOut } = useSession()
  const [entries, setEntries] = useState(me?.orgs || [])
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const copy = useWorkspaceCopy(); const c = useWorkspaceColors()
  useFocusEffect(useCallback(() => {
    let live = true
    void api.me().then(who => { if (live) setEntries(who.orgs || []) }).catch(() => {})
    return () => { live = false }
  }, [api]))
  const current = entries.find(w => w.id === orgId)
  const ordered = [...entries].sort((a, b) => Number(b.id === orgId) - Number(a.id === orgId))
  const action = (mode: 'settings' | 'add') => { setOpen(false); router.push({ pathname: '/workspace', params: { mode } }) }
  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await operation(); setOpen(false) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel={copy.name} accessibilityState={{ expanded: open }} onPress={() => setOpen(true)} style={[styles.trigger, { backgroundColor: c.bg }]}><Text style={{ color: c.text, fontSize: 17, fontWeight: '600' }}>{workspaceName(current, copy.name)} ▾</Text></Pressable>
    <Modal transparent visible={open} animationType="fade" onRequestClose={() => setOpen(false)}>
      <SafeAreaView style={styles.overlay}>
        <Pressable style={StyleSheet.absoluteFill} accessibilityLabel={copy.close} accessibilityRole="button" onPress={() => setOpen(false)} />
        <View accessibilityViewIsModal style={[styles.menu, { backgroundColor: c.bg, borderColor: c.border }]}>
          <ScrollView>
            {(ordered.length ? ordered : [{ id: orgId || '', name: null }]).map(w => <Pressable key={w.id} disabled={busy} accessibilityRole="button" accessibilityState={{ selected: w.id === orgId }} onPress={() => void run(() => chooseOrg(w.id))}><WorkspaceIdentity workspace={w} fallback={copy.name} /></Pressable>)}
            <View style={[styles.divider, { backgroundColor: c.border }]} />
            <Pressable disabled={busy} style={styles.action} onPress={() => action('settings')} accessibilityRole="button"><Text style={{ color: c.text, fontSize: 16 }}>{copy.settings}</Text></Pressable>
            <View style={[styles.divider, { backgroundColor: c.border }]} />
            <Pressable disabled={busy} style={styles.action} onPress={() => action('add')} accessibilityRole="button"><Text style={{ color: c.text, fontSize: 16 }}>{copy.add}</Text></Pressable>
            <Pressable disabled={busy} style={styles.action} onPress={() => void run(signOut)} accessibilityRole="button"><Text style={{ color: c.text, fontSize: 16 }}>{copy.signOut}</Text></Pressable>
            {!!error && <Text accessibilityRole="alert" style={{ color: c.text, padding: 24 }}>{error}</Text>}
          </ScrollView>
        </View>
      </SafeAreaView>
    </Modal>
  </>
}
const styles = StyleSheet.create({
  trigger: { padding: 16, minHeight: 48 }, overlay: { flex: 1, padding: 16, backgroundColor: '#0006' },
  menu: { width: '100%', maxWidth: 380, maxHeight: '90%', borderWidth: 1, borderRadius: 8, paddingVertical: 8, overflow: 'hidden' },
  identity: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 24, paddingVertical: 16 },
  icon: { width: 40, height: 40, borderRadius: 9 }, letter: { alignItems: 'center', justifyContent: 'center' }, name: { fontSize: 17, fontWeight: '600', marginBottom: 3 },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: 8 }, action: { paddingHorizontal: 24, paddingVertical: 12, minHeight: 48 },
})
