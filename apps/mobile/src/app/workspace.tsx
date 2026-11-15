import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { ApiError } from '@honmaru/core'
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
  const [simpleOnly, setSimpleOnly] = useState<boolean | null>(null)
  const [preferenceRevision, setPreferenceRevision] = useState(0)
  const [preferenceBusy, setPreferenceBusy] = useState(false)
  const [preferenceLoading, setPreferenceLoading] = useState(false)
  const copy = useWorkspaceCopy(); const c = useWorkspaceColors()
  const reloadPreference = useCallback(() => {
    if (!orgId) return
    setPreferenceLoading(true)
    void api.workspaceMode(orgId).then(snapshot => {
      setSimpleOnly(snapshot.simpleOnly); setPreferenceRevision(snapshot.revision)
    }).catch(() => setSimpleOnly(null)).finally(() => setPreferenceLoading(false))
  }, [api, orgId])
  useFocusEffect(useCallback(() => {
    if (!orgId || mode !== 'settings') return
    let live = true
    setPreferenceLoading(true)
    void api.workspaceMode(orgId).then(snapshot => {
      if (live) { setSimpleOnly(snapshot.simpleOnly); setPreferenceRevision(snapshot.revision) }
    }).catch(() => { if (live) setSimpleOnly(null) })
      .finally(() => { if (live) setPreferenceLoading(false) })
    return () => { live = false }
  }, [api, mode, orgId]))
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
  const saveSimpleOnly = async (next: boolean) => {
    if (!orgId || simpleOnly === null || preferenceBusy) return
    const savingOrg = orgId
    setPreferenceBusy(true); setError('')
    try {
      const saved = await api.setSimpleOnly(savingOrg, next, preferenceRevision)
      if (orgId === savingOrg) { setSimpleOnly(saved.simpleOnly); setPreferenceRevision(saved.revision) }
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        try {
          const latest = await api.workspaceMode(savingOrg)
          if (orgId === savingOrg) { setSimpleOnly(latest.simpleOnly); setPreferenceRevision(latest.revision); setError(copy.preferenceConflict) }
        } catch { if (orgId === savingOrg) setError(cause.message) }
      } else if (orgId === savingOrg) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally { setPreferenceBusy(false) }
  }
  const title = mode === 'settings' ? copy.settings : mode === 'create' ? copy.create : mode === 'join' ? copy.join : copy.add
  return <ScrollView style={{ backgroundColor: c.bg }} contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
    <Stack.Screen options={{ title }} />
    {loading ? <ActivityIndicator /> : <>
      {mode === 'settings' && <WorkspaceIdentity workspace={workspace} fallback={copy.name} />}
      {mode === 'settings' && <View style={[styles.preference, { borderColor: c.border }]}>
        <View style={styles.preferenceCopy}>
          <Text style={{ color: c.text, fontSize: 16, fontWeight: '600' }}>{copy.simpleOnly}</Text>
          <Text style={{ color: c.secondary, marginTop: 5, lineHeight: 20 }}>{copy.simpleOnlyHint}</Text>
        </View>
        {preferenceLoading ? <ActivityIndicator accessibilityLabel={copy.simpleOnly} /> : simpleOnly === null ? <Pressable accessibilityRole="button" onPress={reloadPreference}><Text style={{ color: c.text }}>{copy.preferenceUnavailable} {copy.retry}</Text></Pressable> : <Switch
          accessibilityLabel={copy.simpleOnly}
          disabled={preferenceBusy}
          value={simpleOnly}
          onValueChange={value => void saveSimpleOnly(value)}
          trackColor={{ false: c.border, true: '#6258d9' }}
        />}
      </View>}
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
const styles = StyleSheet.create({ screen: { padding: 24, gap: 12 }, action: { paddingVertical: 14, minHeight: 48 }, input: { borderWidth: 1, borderRadius: 8, padding: 12, fontSize: 17 }, preference: { borderWidth: 1, borderRadius: 12, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 16 }, preferenceCopy: { flex: 1 } })
