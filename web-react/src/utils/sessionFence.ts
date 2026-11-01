// A request or dialog belongs to the exact account that initiated it. Storage
// events are asynchronous, so compare the current saved identity again before
// prompting, retrying a request, or leaving the page.
export interface SessionFence {
  current: () => boolean
  credential: () => string | null
  release: () => void
}

export function sessionFence(url: string, token: string): SessionFence {
  let secret: string | null = token || null
  let user: string | null = null
  let host: string | null = null
  let rawHost: string | null = null
  let valid = true
  try {
    user = localStorage.getItem('userId')
    rawHost = localStorage.getItem('host')
    host = rawHost || import.meta.env.VITE_API_HOST || 'localhost:8787'
  } catch { /* denied storage fails closed */ }
  const current = () => {
    try {
      if (!valid || !secret || !user || !host || localStorage.getItem('sessionToken') !== secret || localStorage.getItem('userId') !== user ||
          (localStorage.getItem('host') || import.meta.env.VITE_API_HOST || 'localhost:8787') !== host) return false
      const scheme=window.location.protocol === 'https:' ? 'https' : 'http'
      const expected=new URL(`${scheme}://${host}`).href.replace(/\/+$/, '')
      const actual=new URL(url,window.location.href).href
      return actual===expected || actual.startsWith(`${expected}/`) || actual.startsWith(`${expected}?`)
    } catch { return false }
  }
  const onStorage=(event: Event)=>{
    const e=event as StorageEvent
    if(e.key===null || (e.key==='sessionToken' && e.newValue!==secret) ||
       (e.key==='userId' && e.newValue!==user) || (e.key==='host' && e.newValue!==rawHost) ||
       (e.key===undefined && !current()))valid=false
  }
  window.addEventListener('storage',onStorage)
  return { current, credential: () => current() ? secret : null, release: () => { window.removeEventListener('storage',onStorage);valid=false;secret=null;user=null;host=null;rawHost=null } }
}

// SSO can also start from the signed-out screen. Record even an empty session
// so another tab signing in while the verifier is prepared cancels the start.
export function authStorageSnapshot(): { current: () => boolean; release: () => void } {
  let token: string | null = null, user: string | null = null, host: string | null = null, readable = false
  try { token=localStorage.getItem('sessionToken');user=localStorage.getItem('userId');host=localStorage.getItem('host');readable=true } catch { /* unavailable */ }
  const onStorage=(event:Event)=>{
    const e=event as StorageEvent
    if(e.key===null || (e.key==='sessionToken' && e.newValue!==token) || (e.key==='userId' && e.newValue!==user) ||
      (e.key==='host' && e.newValue!==host))readable=false
  }
  window.addEventListener('storage',onStorage)
  return {
    current:()=>{
      try { return readable && localStorage.getItem('sessionToken')===token && localStorage.getItem('userId')===user && localStorage.getItem('host')===host }
      catch { return false }
    },
    release:()=>{window.removeEventListener('storage',onStorage);token=null;user=null;host=null;readable=false},
  }
}
