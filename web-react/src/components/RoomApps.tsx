import React, { useEffect, useState } from 'react'
import { useT } from '../utils/i18n'
import { hashForScreen } from '../utils/route'
import type { App } from '../utils/harness'

// The apps linked to a room (docs/kylon-gap-plan.md): in a harness
// workspace, a room's details list them next to its automations, one tap
// from the app. A simple workspace's server says nothing is linked, and
// nothing is drawn.

export const OPEN_APP_KEY = 'hx.openApp'

export function RoomApps({ httpBase, orgId, headers, view }: { httpBase: string; orgId: string; headers: Record<string, string>; view: string }) {
  const t = useT()
  const [apps, setApps] = useState<App[]>([])
  useEffect(() => {
    let live = true
    if (!view.startsWith('b:')) { setApps([]); return }
    const q = new URLSearchParams({ orgId, channel: view })
    fetch(`${httpBase}/orgs/mode?orgId=${encodeURIComponent(orgId)}`, { headers })
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => (m?.mode === 'harness' ? fetch(`${httpBase}/apps?${q}`, { headers }).then((r) => (r.ok ? r.json() : null)) : null))
      .then((d) => { if (live) setApps(d?.apps || []) })
      .catch(() => { if (live) setApps([]) })
    return () => { live = false }
  }, [httpBase, orgId, headers, view])
  if (!apps.length) return null
  return (
    <div className="slk-room-apps">
      <div className="slk-details-sub">{t('Apps in this room')}</div>
      <ul className="slk-details-list">
        {apps.map((a) => (
          <li key={a.id} className="slk-automation">
            <a
              className="slk-member-main"
              href={hashForScreen('apps')}
              onClick={() => { try { sessionStorage.setItem(OPEN_APP_KEY, a.id) } catch { /* opens the list instead */ } }}
              data-room-app={a.id}
            >
              <span className="slk-member-name">{a.icon} {a.name}</span>
              <span className="slk-member-title">{a.description}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}
