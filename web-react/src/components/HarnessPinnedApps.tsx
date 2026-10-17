import React, { useEffect, useMemo, useState } from 'react'
import { harnessApi, type App } from '../utils/harness'
import { useAppPins } from '../utils/appPins'
import { hashForApp } from '../utils/route'
import { HarnessAppIcon } from './HarnessAppIcon'

export function HarnessPinnedApps({ httpBase, orgId, sessionToken }: { httpBase: string; orgId: string; sessionToken: string }) {
  const { pins } = useAppPins(orgId)
  const api = useMemo(() => harnessApi(httpBase, orgId, sessionToken), [httpBase, orgId, sessionToken])
  const [apps, setApps] = useState<App[]>([])
  useEffect(() => { let live = true; setApps([]); if (pins.length) api.apps().then(result => { if (live) setApps(result.apps) }).catch(() => {}); return () => { live = false } }, [api, pins])
  return <>{pins.map(id => apps.find(app => app.id === id)).filter((app): app is App => !!app).map(app => <button key={app.id} className="hx-pinned-app" title={app.name} aria-label={`${app.name}を開く`} onClick={() => { location.hash = hashForApp(app.id, orgId) }}><HarnessAppIcon icon={app.icon} size={17} /></button>)}</>
}
