import { router, Stack, useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSession } from '../lib/session'
import { useWorkspaceColors, useWorkspaceCopy, WorkspaceIdentity, type Workspace } from '../components/WorkspaceMenu'

export default function WorkspaceScreen() {
  const { mode: requested } = useLocalSearchParams<{ mode: string }>()
  const [mode, setMode] = useState(requested === 'add' ? 'add' : 'settings')
  const { api, orgId, chooseOrg } = useSession()
  const [workspace, setWorkspace] = useState<Workspace>()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const copy = useWorkspaceCopy(); const c = useWorkspaceColors()
  useEffect(() => {
    let live = true
    api.me().then(who => { if (live) { const w = who.orgs?.find(o => o.id === orgId); setWorkspace(w); if (requested !== 'add') setValue(w?.name || '') } })
      .catch(e => { if (live) setError(e instanceof Error ? e.message : String(e)) }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [api, orgId, requested])
  const canRename = workspace?.role === 'owner' || workspace?.role === 'admin'
  const submit = async () => {
    if (!value.trim() || busy) return
    setBusy(true); setError('')
    try {
      if (mode === 'settings') {
        await api.request('/orgs/name', { method: 'PUT', body: { orgId, name: value.trim() } })
      } else if (mode === 'create') {
        const result = await api.request<{ orgId: string }>('/orgs', { method: 'POST', body: { name: value.trim() } })
        await chooseOrg(result.orgId)
      } else {
        const text = value.trim()
        const code = /(?:join\/|code=|invite=)([A-Za-z0-9_-]+)/.exec(text)?.[1] || text
        const result = await api.acceptInvite(code)
        if (result.pending) { setPending(true); return }
        await chooseOrg(result.orgId)
      }
      router.replace('/')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const title = mode === 'settings' ? copy.settings : mode === 'create' ? copy.create : mode === 'join' ? copy.join : copy.add
  return <ScrollView style={{ backgroundColor: c.bg }} contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
    <Stack.Screen options={{ title }} />
    {loading ? <ActivityIndicator /> : <>
      {mode === 'settings' && <WorkspaceIdentity workspace={workspace} fallback={copy.name} />}
      {mode === 'add' ? <>
        <Pressable accessibilityRole="button" style={styles.action} onPress={() => { setMode('create'); setValue('') }}><Text style={{ color: c.text, fontSize: 17 }}>{copy.create}</Text></Pressable>
        <View style={{ height: 1, backgroundColor: c.border }} />
        <Pressable accessibilityRole="button" style={styles.action} onPress={() => { setMode('join'); setValue('') }}><Text style={{ color: c.text, fontSize: 17 }}>{copy.join}</Text></Pressable>
      </> : pending ? <Text style={{ color: c.text }}>{copy.pending}</Text> : (mode !== 'settings' || canRename) && <>
        <Text style={{ color: c.secondary }}>{mode === 'join' ? copy.code : copy.name}</Text>
        <TextInput accessibilityLabel={mode === 'join' ? copy.code : copy.name} value={value} onChangeText={setValue} editable={!busy} maxLength={mode === 'join' ? 400 : 60} autoCapitalize={mode === 'join' ? 'none' : 'sentences'} autoCorrect={mode !== 'join'} style={[styles.input, { color: c.text, borderColor: c.border }]} />
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy || !value.trim() }} disabled={busy || !value.trim()} style={[styles.action, { opacity: busy || !value.trim() ? 0.5 : 1 }]} onPress={() => void submit()}>{busy ? <ActivityIndicator /> : <Text style={{ color: c.text, fontSize: 17 }}>{mode === 'settings' ? copy.save : title}</Text>}</Pressable>
      </>}
    </>}
    {!!error && <Text accessibilityRole="alert" style={{ color: c.text }}>{error}</Text>}
  </ScrollView>
}
const styles = StyleSheet.create({ screen: { padding: 24, gap: 12 }, action: { paddingVertical: 14, minHeight: 48 }, input: { borderWidth: 1, borderRadius: 8, padding: 12, fontSize: 17 } })
