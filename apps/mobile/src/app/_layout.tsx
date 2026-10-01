import { router, Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useEffect } from 'react'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { onNotificationTap } from '../lib/push'
import { SessionProvider, useSession } from '../lib/session'

function Screens() {
  const { ready, token, me, orgId, chooseOrg } = useSession()

  // A tapped notification opens its conversation, in its workspace — once
  // someone is signed in and the workspace is known, so a tap that launched
  // the app waits for that rather than being lost.
  useEffect(() => {
    if (!ready || !token || !me || !orgId) return
    return onNotificationTap((target) => {
      const known = target.orgId === orgId || (me.orgs || []).some((o) => o.id === target.orgId)
      if (!known) return
      void (async () => {
        if (target.orgId !== orgId) await chooseOrg(target.orgId)
        router.push({ pathname: '/c/[channel]', params: { channel: target.channel } })
      })()
    })
  }, [ready, token, me, orgId, chooseOrg])

  if (!ready) return null
  return (
    <Stack>
      <Stack.Protected guard={Boolean(token)}>
        <Stack.Screen name="index" options={{ title: 'Channels' }} />
        <Stack.Screen name="c/[channel]" options={{ title: '' }} />
      </Stack.Protected>
      <Stack.Protected guard={!token}>
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
      </Stack.Protected>
      {/* An invitation link, signed in or not (it sends you to sign in). */}
      <Stack.Screen name="join/[code]" options={{ title: 'Join' }} />
    </Stack>
  )
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <StatusBar style="auto" />
        <Screens />
      </SessionProvider>
    </SafeAreaProvider>
  )
}
