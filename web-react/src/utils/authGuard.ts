/// Two answers the Worker gives that no single screen should have to handle.
///
/// `reauth-required`: an admin action wants a recent sign-in. The person is
/// asked to confirm it is them (ReauthDialog), and the same request is sent
/// once more — the action they were taking simply goes through.
///
/// `session-policy`: this workspace's login rules have ended this sign-in.
/// The app hears `honmaru:session-policy` and signs them out with a reason.
///
/// `dlp-warning`: one of the workspace's data rules thinks a message holds
/// something it should not. The person is asked (DlpDialog); if they send it
/// anyway, the same request goes again with `dlpAck`. A block is not asked
/// about: the screen shows its message like any refusal.

export interface ReauthRequest {
  base: string
  token: string
  resolve: (confirmed: boolean) => void
}

let installed = false

const headerOf = (init: RequestInit | undefined, name: string): string | null => {
  const h = init?.headers
  if (!h) return null
  if (h instanceof Headers) return h.get(name)
  if (Array.isArray(h)) return h.find(([k]) => k.toLowerCase() === name)?.[1] ?? null
  const found = Object.entries(h as Record<string, string>).find(([k]) => k.toLowerCase() === name)
  return found ? found[1] : null
}

/// Ask whoever is listening (ReauthDialog) to confirm; false when nobody is.
export function askToConfirm(base: string, token: string): Promise<boolean> {
  return new Promise((resolve) => {
    const event = new CustomEvent<ReauthRequest>('honmaru:reauth', { detail: { base, token, resolve }, cancelable: true })
    // Not handled means nothing is mounted to ask: go on as refused.
    if (window.dispatchEvent(event)) resolve(false)
  })
}

export interface DlpWarning {
  rules: string[]
  /// Attached files the rules were met in, by name.
  files?: string[]
  resolve: (send: boolean) => void
}

/// Ask whoever is listening (DlpDialog); false — do not send — when nobody is.
export function askAboutData(rules: string[], files: string[] = []): Promise<boolean> {
  return new Promise((resolve) => {
    const event = new CustomEvent<DlpWarning>('honmaru:dlp-warning', { detail: { rules, files, resolve }, cancelable: true })
    if (window.dispatchEvent(event)) resolve(false)
  })
}

export function installAuthGuard() {
  if (installed || typeof window === 'undefined') return
  installed = true
  const original = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await original(input, init)
    if (res.status === 409 && typeof init?.body === 'string') {
      const said = await res.clone().json().catch(() => null) as { code?: string; rules?: string[]; files?: string[] } | null
      if (said?.code !== 'dlp-warning') return res
      let body: Record<string, unknown> | null = null
      try { body = JSON.parse(init.body) as Record<string, unknown> } catch { return res }
      if (!body || typeof body !== 'object' || !(await askAboutData(said.rules || [], said.files || []))) return res
      return original(input, { ...init, body: JSON.stringify({ ...body, dlpAck: true }) })
    }
    if (res.status !== 401 && res.status !== 403) return res
    const token = headerOf(init, 'x-session-token')
    if (!token) return res
    const said = await res.clone().json().catch(() => null) as { code?: string; orgId?: string; start?: string } | null
    // The workspace wants its single sign-on: off to the provider.
    if (said?.code === 'sso-required' || said?.code === 'sso-reauth') {
      window.dispatchEvent(new CustomEvent('honmaru:sso-required', { detail: { orgId: said.orgId || null, start: said.start || null } }))
      return res
    }
    if (res.status !== 401) return res
    if (said?.code === 'session-policy') {
      window.dispatchEvent(new CustomEvent('honmaru:session-policy', { detail: { orgId: said.orgId || null } }))
      return res
    }
    if (said?.code === 'reauth-required') {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const base = new URL(url, window.location.href).origin
      // A body that can be sent again is sent again; a stream cannot be.
      const again = init?.body === undefined || typeof init.body === 'string'
      if (again && await askToConfirm(base, token)) return original(input, init)
    }
    return res
  }
}
