import React, { useCallback, useMemo, useState } from 'react'
import { useT } from '../utils/i18n'
import { harnessApi, type HarnessApi } from '../utils/harness'
import './Harness.css'

// What every harness screen shares: its props, its frame, its API client
// and the way it runs work and shows what went wrong.

export interface HarnessProps {
  httpBase: string
  orgId: string
  sessionToken: string
  onClose: () => void
}

export type HarnessScreen = 'harness' | 'apps' | 'workflows' | 'approvals' | 'skills' | 'hxagents'

export function Shell({ title, onClose, children, actions }: { title: string; onClose: () => void; children: React.ReactNode; actions?: React.ReactNode }) {
  const t = useT()
  return (
    <div className="screen hx-screen">
      <div className="screen-head">
        <button className="back" onClick={onClose} aria-label={t('Close')}>‹</button>
        <span className="head-title">{title}</span>
        {actions && <span className="hx-head-actions">{actions}</span>}
      </div>
      <div className="screen-body">{children}</div>
    </div>
  )
}

export function useApi(p: HarnessProps): HarnessApi {
  return useMemo(() => harnessApi(p.httpBase, p.orgId, p.sessionToken), [p.httpBase, p.orgId, p.sessionToken])
}

/// Run some work, keeping its error to show.
export function useAct() {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const act = useCallback(async (key: string, work: () => Promise<void>) => {
    setBusy(key); setError(null)
    try { await work() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(null) }
  }, [])
  return { busy, error, setError, act }
}

