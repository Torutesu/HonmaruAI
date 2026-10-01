// Sign in with a password or a code sent by email (the same /auth/otp routes the web and
// the iPhone app use), or with Apple on iOS (/auth/apple). An invitation
// link opened while signed out lands here with its code, spent on the way in.

import * as AppleAuthentication from 'expo-apple-authentication'
import { useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { ApiError } from '@honmaru/core'
import type { SignedIn } from '@honmaru/protocol'
import { appleSignInAvailable, signInWithApple } from '../lib/apple'
import { useSession } from '../lib/session'

export default function SignIn() {
  const { api, signIn } = useSession()
  const { invite } = useLocalSearchParams<{ invite?: string }>()
  const inviteCode = typeof invite === 'string' && /^[0-9a-f]{16,64}$/i.test(invite) ? invite : undefined
  const [apple, setApple] = useState(false)
  useEffect(() => { void appleSignInAvailable().then(setApple) }, [])
  // Joined by the invitation: land in that workspace.
  const finish = (r: SignedIn) => signIn(r.token, inviteCode && !r.inviteError ? r.orgId : null)
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [passwordMode, setPasswordMode] = useState(false)
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (task: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await task() } catch (err) { setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.') }
    finally { setBusy(false) }
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.card}>
        <Text style={styles.title}>Honmaru</Text>
        {inviteCode ? <Text style={styles.hint}>Sign in to join the team you were invited to.</Text> : null}
        {!sent ? (
          <>
            <TextInput
              style={styles.input} placeholder="you@company.com" autoCapitalize="none" autoComplete="email"
              keyboardType="email-address" textContentType="emailAddress" value={email} onChangeText={setEmail}
            />
            {passwordMode ? (
              <TextInput
                style={styles.input} placeholder="Password" accessibilityLabel="Password"
                secureTextEntry autoCapitalize="none" autoCorrect={false}
                autoComplete="current-password" textContentType="password"
                value={password} onChangeText={setPassword} editable={!busy}
              />
            ) : null}
            <Pressable style={styles.button} disabled={busy || !email.includes('@') || (passwordMode && !password)}
              onPress={() => run(async () => {
                if (passwordMode) {
                  const result = await api.signInWithPassword({ email: email.trim(), password, inviteCode })
                  setPassword('')
                  await finish(result)
                } else {
                  await api.requestCode({ email: email.trim() }); setSent(true)
                }
              })}>
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{passwordMode ? 'Sign in' : 'Send code'}</Text>}
            </Pressable>
            <Pressable disabled={busy} onPress={() => { setPasswordMode(!passwordMode); setPassword(''); setError(null) }}>
              <Text style={styles.link}>{passwordMode ? 'Use an email code instead' : 'Sign in with a password'}</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={styles.hint}>We sent a code to {email.trim()}.</Text>
            <TextInput
              style={styles.input} placeholder="123456" keyboardType="number-pad" textContentType="oneTimeCode"
              autoComplete="one-time-code" value={code} onChangeText={setCode}
            />
            <Pressable style={styles.button} disabled={busy || code.trim().length < 4}
              onPress={() => run(async () => { await finish(await api.verifyCode({ email: email.trim(), code: code.trim(), inviteCode })) })}>
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign in</Text>}
            </Pressable>
            <Pressable onPress={() => { setSent(false); setCode('') }}><Text style={styles.link}>Use another address</Text></Pressable>
          </>
        )}
        {apple && !sent ? (
          <AppleAuthentication.AppleAuthenticationButton
            buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
            buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
            cornerRadius={10}
            style={styles.apple}
            onPress={() => { if (!busy) void run(async () => { const r = await signInWithApple(api, inviteCode); if (r) await finish(r) }) }}
          />
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'center', padding: 24 },
  card: { gap: 12 },
  title: { fontSize: 32, fontWeight: '700', marginBottom: 12 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderColor: '#999', borderRadius: 10, padding: 14, fontSize: 17 },
  button: { backgroundColor: '#1f6feb', borderRadius: 10, padding: 14, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  hint: { fontSize: 15, color: '#666' },
  link: { color: '#1f6feb', textAlign: 'center', padding: 8 },
  error: { color: '#d1242f' },
  apple: { height: 48, width: '100%' },
})
