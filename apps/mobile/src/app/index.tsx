// The workspace's channels, with unread counts from its Durable Object.

import { Link, useFocusEffect } from 'expo-router'
import { useCallback, useRef, useState } from 'react'
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import type { Business } from '@honmaru/protocol'
import { useSession } from '../lib/session'
import { WorkspaceMenu } from '../components/WorkspaceMenu'

export default function Channels() {
  const { api, orgId } = useSession()
  const requestId = useRef(0)
  const [channels, setChannels] = useState<Business[]>([])
  const [unread, setUnread] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!orgId) return
    const request = ++requestId.current
    setChannels([]); setUnread({})
    setLoading(true); setError(null)
    try {
      const { businesses } = await api.businesses(orgId)
      if (request !== requestId.current) return
      setChannels(businesses)
      const counts = await api.unread(orgId, businesses.map((b) => `b:${b.slug}`)).catch(() => ({ channels: [] }))
      if (request !== requestId.current) return
      setUnread(Object.fromEntries(counts.channels.map((c) => [c.channel, c.unread])))
    } catch (err) {
      if (request !== requestId.current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (request === requestId.current) setLoading(false)
    }
  }, [api, orgId])

  useFocusEffect(useCallback(() => { void load(); return () => { requestId.current += 1 } }, [load]))

  return (
    <FlatList
      data={channels}
      keyExtractor={(b) => b.slug}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
      ListHeaderComponent={<><WorkspaceMenu />{error ? <Text style={styles.error}>{error}</Text> : null}</>}
      renderItem={({ item }) => {
        const key = `b:${item.slug}`
        const n = unread[key] || 0
        return (
          <Link href={{ pathname: '/c/[channel]', params: { channel: key, name: item.name } }} asChild>
            <Pressable style={styles.row}>
              <Text style={[styles.name, n ? styles.unread : null]}>{item.private ? '🔒 ' : '# '}{item.name}</Text>
              {n ? <View style={styles.badge}><Text style={styles.badgeText}>{n > 99 ? '99+' : n}</Text></View> : null}
            </Pressable>
          </Link>
        )
      }}
    />
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14 },
  name: { flex: 1, fontSize: 17 },
  unread: { fontWeight: '700' },
  badge: { backgroundColor: '#d1242f', borderRadius: 10, minWidth: 20, paddingHorizontal: 6, paddingVertical: 2, alignItems: 'center' },
  badgeText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  footer: { padding: 24 },
  link: { color: '#1f6feb', textAlign: 'center' },
  error: { color: '#d1242f', padding: 16 },
})
