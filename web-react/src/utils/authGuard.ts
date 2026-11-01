// Shared handling for reauthentication, workspace policy and DLP warnings.
// A confirmation belongs to the account that started the request; a later
// account must never approve, replay or inherit it.
import { sessionFence, type SessionFence } from './sessionFence'

export interface ReauthRequest {
  base: string
  start: () => Promise<Response>
  confirm: (body: {password:string} | {code:string}) => Promise<Response>
  current: () => boolean
  resolve: (confirmed: boolean) => void
}

let installed = false

// Dashboard uses this before emitting a policy event from its socket.
export function requestSessionIsCurrent(base: string, token: string): boolean {
  const fence = sessionFence(base, token)
  try { return fence.current() } finally { fence.release() }
}

const headerOf = (input: RequestInfo | URL, init: RequestInit | undefined, name: string): string | null => {
  const h = init?.headers || (input instanceof Request ? input.headers : undefined)
  if (!h) return null
  if (h instanceof Headers) return h.get(name)
  if (Array.isArray(h)) return h.find(([k]) => k.toLowerCase() === name)?.[1] ?? null
  const found = Object.entries(h as Record<string, string>).find(([k]) => k.toLowerCase() === name)
  return found ? found[1] : null
}
const urlOf = (input: RequestInfo | URL) => typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

// The token stays in the private fence, never in CustomEvent.detail. Its
// callbacks refuse to start network requests once the account changes.
export function askToConfirm(base: string, fence: SessionFence): Promise<boolean> {
  return new Promise((resolve) => {
    let answered=false
    const controller=new AbortController()
    const onStorage=()=>{if(!fence.current())answer(false)}
    const answer=(confirmed:boolean)=>{
      if(answered)return
      const permitted=confirmed && fence.current()
      answered=true
      controller.abort()
      window.removeEventListener('storage',onStorage)
      window.removeEventListener('honmaru:workspace-changed',onStorage)
      resolve(permitted)
    }
    const post=(path:string,body:unknown)=>{
      const token=fence.credential()
      if(!token || answered)return Promise.reject(new Error('Session changed.'))
      return fetch(`${base}${path}`,{method:'POST',headers:{'x-session-token':token,'content-type':'application/json'},body:JSON.stringify(body),signal:controller.signal})
    }
    const detail: ReauthRequest={base,start:()=>post('/auth/reauth/start',{}),confirm:body=>post('/auth/reauth',body),current:()=>!answered&&fence.current(),resolve:answer}
    window.addEventListener('storage',onStorage)
    window.addEventListener('honmaru:workspace-changed',onStorage)
    const event = new CustomEvent<ReauthRequest>('honmaru:reauth', { detail, cancelable: true })
    if (!fence.current() || window.dispatchEvent(event)) answer(false)
  })
}

export interface DlpWarning {
  rules: string[]
  files?: string[]
  current: () => boolean
  resolve: (send: boolean) => void
}

let asking = 0
export const askingAboutData = () => asking > 0

export function askAboutData(rules: string[], files: string[] = [], fence?: SessionFence): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false
    const current=()=>!answered && (!fence || fence.current())
    const onStorage=()=>{if(!current())answer(false)}
    const answer = (send: boolean) => {
      if (answered) return
      const permitted=send && current()
      answered = true
      asking--
      window.removeEventListener('storage',onStorage)
      window.removeEventListener('honmaru:workspace-changed',onStorage)
      resolve(permitted)
    }
    asking++
    window.addEventListener('storage',onStorage)
    window.addEventListener('honmaru:workspace-changed',onStorage)
    const event = new CustomEvent<DlpWarning>('honmaru:dlp-warning', { detail: { rules, files, current, resolve: answer }, cancelable: true })
    if (!current() || window.dispatchEvent(event)) answer(false)
  })
}

export function installAuthGuard() {
  if (installed || typeof window === 'undefined') return
  installed = true
  const original = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const token=headerOf(input,init,'x-session-token')
    if(!token)return original(input,init)
    const url=urlOf(input), base=new URL(url,window.location.href).origin
    const fence=sessionFence(url,token)
    let retryInput: RequestInfo | URL = input
    let replayable=true
    if(input instanceof Request) {
      try { retryInput=input.clone() } catch { replayable=false }
    }
    try {
      const res = await original(input, init)
      if (res.status !== 409 && res.status !== 401 && res.status !== 403) return res
      if(!fence.current())return res
      if (res.status === 409 && typeof init?.body === 'string') {
        const said = await res.clone().json().catch(() => null) as { code?: string; rules?: string[]; files?: string[] } | null
        if (said?.code !== 'dlp-warning' || !fence.current()) return res
        let body: Record<string, unknown> | null = null
        try { body = JSON.parse(init.body) as Record<string, unknown> } catch { return res }
        if (!body || typeof body !== 'object' || !(await askAboutData(said.rules || [], said.files || [],fence)) || !fence.current()) return res
        return original(input, { ...init, body: JSON.stringify({ ...body, dlpAck: true }) })
      }
      if(res.status===409)return res
      const said = await res.clone().json().catch(() => null) as { code?: string; orgId?: string; start?: string } | null
      if(!fence.current())return res
      if (said?.code === 'ip-not-allowed') {
        window.dispatchEvent(new CustomEvent('honmaru:ip-not-allowed', { detail: { orgId: said.orgId || null } }))
        return res
      }
      if (said?.code === 'sso-required' || said?.code === 'sso-reauth') {
        window.dispatchEvent(new CustomEvent('honmaru:sso-required', { detail: { orgId: said.orgId || null, start: said.start || null, base } }))
        return res
      }
      if (res.status !== 401) return res
      if (said?.code === 'session-policy') {
        window.dispatchEvent(new CustomEvent('honmaru:session-policy', { detail: { orgId: said.orgId || null, base } }))
        return res
      }
      if (said?.code === 'reauth-required') {
        const again = replayable && (init?.body === undefined || typeof init.body === 'string')
        if (again && await askToConfirm(base, fence) && fence.current()) return original(retryInput, init)
      }
      return res
    } finally { fence.release() }
  }
}
