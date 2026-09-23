// Sign in with GitHub, on the web. The same OAuth app the phone uses, with a
// second callback registered for the web's own origin. GitHub sends the
// browser back here with ?code&state; the Worker trades the code for a
// session and keeps the GitHub token to itself.

const STATE_KEY = 'oauthState'

export interface GitHubWebConfig { clientId: string; redirectUri: string; scope: string }

/// Whether this deployment offers GitHub sign-in to browsers.
export async function githubWebConfig(httpBase: string): Promise<GitHubWebConfig | null> {
  try {
    const res = await fetch(`${httpBase}/oauth/github/config?client=web`)
    if (!res.ok) return null
    const cfg = await res.json()
    return cfg?.clientId && cfg?.redirectUri ? cfg : null
  } catch { return null }
}

/// Leave for GitHub. The state is minted by the Worker and kept here to be
/// checked on the way back.
export async function beginGitHubSignIn(httpBase: string, cfg: GitHubWebConfig): Promise<void> {
  const res = await fetch(`${httpBase}/oauth/github/state`)
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || 'Could not start the sign-in.')
  const { state } = await res.json()
  try { localStorage.setItem(STATE_KEY, state) } catch { /* the Worker checks it too */ }
  const url = new URL('https://github.com/login/oauth/authorize')
  url.searchParams.set('client_id', cfg.clientId)
  url.searchParams.set('redirect_uri', cfg.redirectUri)
  url.searchParams.set('scope', cfg.scope)
  url.searchParams.set('state', state)
  location.assign(url.toString())
}

/// The way back: ?code&state on the page. Null when this is not a callback.
export function readCallback(): { code: string; state: string } | null {
  try {
    const url = new URL(location.href)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (!code || !state) return null
    return { code, state }
  } catch { return null }
}

/// Trade the code for a session. The query string is cleared whatever
/// happens: a code is single-use, and a reload must not try it again.
export async function finishGitHubSignIn(httpBase: string, cb: { code: string; state: string }): Promise<{ sessionToken: string; login: string; orgs: string[] }> {
  let expected: string | null = null
  try { expected = localStorage.getItem(STATE_KEY); localStorage.removeItem(STATE_KEY) } catch { /* checked by the Worker */ }
  try {
    const url = new URL(location.href)
    url.searchParams.delete('code'); url.searchParams.delete('state')
    history.replaceState(null, '', url.pathname + url.search + url.hash)
  } catch { /* cosmetic */ }
  // The nonce must be the one this browser minted. No nonce at all is the
  // same refusal: a callback URL pasted from somewhere else would otherwise
  // sign this browser into whoever started that sign-in.
  if (!expected || expected !== cb.state) throw new Error('This sign-in did not start in this browser. Try again.')
  const res = await fetch(`${httpBase}/oauth/github/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: cb.code, state: cb.state, redirectUri: location.origin + location.pathname }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.message || 'GitHub sign-in failed.')
  return { sessionToken: data.sessionToken, login: data.login, orgs: Array.isArray(data.orgs) ? data.orgs : [] }
}
