// What is half-written in a conversation, kept on the phone until it is
// sent — leaving the screen, or the app, loses nothing. Kept in the
// keychain (the one store this app has), each under its own key, with an
// index of them so signing out can take every one away.

import * as SecureStore from 'expo-secure-store'

const INDEX_KEY = 'honmaru.drafts'
// The keychain takes letters, digits and . - _ in a key.
const keyOf = (orgId: string, channel: string) => `honmaru.draft.${`${orgId}|${channel}`.replace(/[^A-Za-z0-9._-]/g, (c) => `_${c.charCodeAt(0).toString(16)}`)}`

async function index(): Promise<string[]> {
  try { return JSON.parse((await SecureStore.getItemAsync(INDEX_KEY)) || '[]') } catch { return [] }
}

export async function loadDraft(orgId: string, channel: string): Promise<string> {
  return (await SecureStore.getItemAsync(keyOf(orgId, channel)).catch(() => null)) || ''
}

// One write after another, in the order they were asked for: the last
// words typed are the ones kept.
let line: Promise<void> = Promise.resolve()
export function saveDraft(orgId: string, channel: string, text: string): Promise<void> {
  line = line.then(() => write(orgId, channel, text))
  return line
}

async function write(orgId: string, channel: string, text: string): Promise<void> {
  const key = keyOf(orgId, channel)
  const kept = await index()
  if (text) {
    await SecureStore.setItemAsync(key, text).catch(() => {})
    if (!kept.includes(key)) await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify([...kept, key])).catch(() => {})
  } else {
    await SecureStore.deleteItemAsync(key).catch(() => {})
    if (kept.includes(key)) await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify(kept.filter((k) => k !== key))).catch(() => {})
  }
}

/// Signing out: this account's words are not the next person's.
export async function clearDrafts(): Promise<void> {
  await line
  for (const key of await index()) await SecureStore.deleteItemAsync(key).catch(() => {})
  await SecureStore.deleteItemAsync(INDEX_KEY).catch(() => {})
}
