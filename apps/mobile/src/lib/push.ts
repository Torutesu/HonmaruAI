// Push notifications: asking, registering this phone with the Worker, and
// opening the conversation a tapped notification is about.
//
// The token is the phone's native one — APNs on an iPhone, FCM on Android —
// from getDevicePushTokenAsync, not an Expo push token: the Worker sends to
// Apple and Google itself (worker/src/apns.js, worker/src/fcm.js), as it
// always has for the iPhone app.
//
// Remote notifications need a development build; Expo Go on Android has none
// since SDK 53, and a simulator has no token. Every step here gives up quietly
// rather than stand between a person and their messages.

import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'
import { pushTarget, type AnyPushTarget, type Api } from '@honmaru/core'
import * as Application from 'expo-application'

const PUSH_TOKEN_KEY = 'honmaru.pushToken'

/// The Android channel messages arrive on; the Worker names it in every FCM
/// message (`channelId`), and app.json makes it the default.
export const MESSAGES_CHANNEL = 'messages'

// At the app, a notification still shows. The Worker already holds back
// pushes for whoever is at the app, so one that arrives is one to see.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
})

/// Ask (once; after that the system remembers), fetch this phone's token and
/// hand it to the Worker for whoever is signed in. Called on every sign-in and
/// every launch, because Apple and Google reissue tokens. Returns the token,
/// or null when there is none to be had.
export async function registerForPush(api: Api): Promise<string | null> {
  if (!Device.isDevice || (Platform.OS !== 'ios' && Platform.OS !== 'android')) return null
  try {
    if (Platform.OS === 'android') {
      // Before asking: Android 13 shows the permission prompt only once a
      // channel exists.
      await Notifications.setNotificationChannelAsync(MESSAGES_CHANNEL, {
        name: 'Messages',
        importance: Notifications.AndroidImportance.HIGH,
      })
    }
    let { status } = await Notifications.getPermissionsAsync()
    if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status
    if (status !== 'granted') return null
    const { data } = await Notifications.getDevicePushTokenAsync()
    if (typeof data !== 'string' || !data) return null
    await sendToken(api, data)
    return data
  } catch (err) {
    // No Firebase config in this build (google-services.json), no APNs
    // entitlement, or the Worker unreachable: the app works without push.
    console.warn('push registration failed', err instanceof Error ? err.message : err)
    return null
  }
}

async function sendToken(api: Api, deviceToken: string) {
  await api.registerDevice({
    deviceToken,
    platform: Platform.OS === 'android' ? 'android' : 'ios',
    ...(Platform.OS === 'ios' ? await iosTarget() : {}),
  })
  await SecureStore.setItemAsync(PUSH_TOKEN_KEY, deviceToken)
}

/// Which app this is and which APNs gateway issued its token, as the phone
/// knows them: the bundle id (the Worker sends under it as the APNs topic),
/// and the entitlement the build was signed with — a development build's
/// token is a sandbox token even when its JavaScript runs in release mode.
async function iosTarget(): Promise<{ appId?: string; environment: 'sandbox' | 'production' }> {
  const signed = await Application.getIosPushNotificationServiceEnvironmentAsync().catch(() => null)
  const environment = signed === 'development' ? 'sandbox' : signed === 'production' ? 'production' : (__DEV__ ? 'sandbox' : 'production')
  return { ...(Application.applicationId ? { appId: Application.applicationId } : {}), environment }
}

/// A token reissued while the app is open goes to the Worker at once.
export function watchPushToken(api: Api): () => void {
  const sub = Notifications.addPushTokenListener(({ data }) => {
    if (typeof data === 'string' && data) void sendToken(api, data).catch(() => {})
  })
  return () => sub.remove()
}

/// Forget this phone on the Worker, before the session that owns it ends, so
/// the next person to sign in here is not sent the last one's messages.
export async function unregisterPush(api: Api): Promise<void> {
  const token = await SecureStore.getItemAsync(PUSH_TOKEN_KEY).catch(() => null)
  if (token) await api.unregisterDevice(token).catch(() => {})
  await SecureStore.deleteItemAsync(PUSH_TOKEN_KEY).catch(() => {})
}

/// Where a tapped notification points: the parsed data on either platform,
/// and on Android the raw FCM data as well.
export function targetOf(response: Notifications.NotificationResponse | null | undefined): AnyPushTarget | null {
  const request = response?.notification?.request
  if (!request) return null
  const trigger = request.trigger as { remoteMessage?: { data?: Record<string, string> } } | null
  return pushTarget(request.content.data, trigger?.remoteMessage?.data)
}

/// The tap that opened the app, and every tap while it is open, each handled
/// once. `open` is called only once the session is ready for it.
export function onNotificationTap(open: (target: AnyPushTarget) => void): () => void {
  const handle = (response: Notifications.NotificationResponse | null) => {
    const target = targetOf(response)
    if (!target) return
    // Handled: a later mount must not open it again.
    Notifications.clearLastNotificationResponse()
    open(target)
  }
  handle(Notifications.getLastNotificationResponse())
  const sub = Notifications.addNotificationResponseReceivedListener(handle)
  return () => sub.remove()
}
