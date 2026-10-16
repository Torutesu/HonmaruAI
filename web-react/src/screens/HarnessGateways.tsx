import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../utils/i18n'
import type { Gateway, GatewayJob } from '../utils/harness'
import { Shell, useApi, useAct, type HarnessProps } from './HarnessShared'

export default function HarnessGateways(props: HarnessProps) {
  const t = useT(), api = useApi(props)
  const [nodes, setNodes] = useState<Gateway[]>([]), [jobs, setJobs] = useState<GatewayJob[]>([])
  const [canManage, setCanManage] = useState(false), [loaded, setLoaded] = useState(false)
  const [name, setName] = useState(''), [token, setToken] = useState(''), [gatewayId, setGatewayId] = useState('')
  const [code, setCode] = useState('return input * 2'), [input, setInput] = useState('21')
  const [revoke, setRevoke] = useState<string | null>(null)
  const { busy, error, act } = useAct()
  // Retain the request ID after ambiguous network failure; a retry cannot run twice.
  const pending = useRef<{ key: string; id: string } | null>(null)
  const load = useCallback(async () => {
    const [n, j] = await Promise.all([api.gateways(), api.gatewayJobs()])
    setNodes(n.gateways); setCanManage(n.canManage); setJobs(j.jobs); setLoaded(true)
  }, [api])
  useEffect(() => { void act('load', load) }, [act, load])
  useEffect(() => {
    if (!jobs.some(j => ['queued', 'running'].includes(j.status))) return
    const timer = window.setInterval(() => { if (!busy) void act('refresh', load) }, 5000)
    return () => window.clearInterval(timer)
  }, [jobs, busy, act, load])
  const execute = () => act('execute', async () => {
    const value: unknown = JSON.parse(input)
    const key = JSON.stringify([gatewayId, code, value])
    if (pending.current?.key !== key) pending.current = { key, id: crypto.randomUUID() }
    await api.execute(gatewayId, code, value, pending.current.id)
    pending.current = null
    await load()
  })
  return <Shell title={t('Execution nodes')} onClose={props.onClose} actions={<button className="pill-btn" disabled={!!busy} onClick={() => void act('refresh', load)}>{t('Reload')}</button>}>
    <p className="lede">{t('Run isolated jobs on your own machines.')}</p>
    <p className="hx-hint">{t('JavaScript runs without network or host files, with a 60-second limit. Results are visible only to the requester.')}</p>
    {error && <div className="form-error" role="alert">{error}</div>}
    {!loaded && <div className="empty">{t('Loading…')}</div>}
    {canManage && <div className="rows"><div className="row static"><div className="row-main">
      <label>{t('Node name')}<input className="hx-cell-input" value={name} maxLength={80} onChange={e => setName(e.target.value)} /></label>
      <p className="row-sub">{t('Register only a trusted machine. Its operator can read the code and input sent to it. The token grants access to that node’s jobs.')}</p>
      <button className="pill-btn" disabled={!!busy || !name.trim() || !!token} onClick={() => void act('register', async () => { const n = await api.registerGateway(name.trim()); setToken(n.token); setName(''); await load() })}>{t('Register node')}</button>
    </div></div></div>}
    {token && <div className="rows"><div className="row static"><div className="row-main">
      <p>{t('Save this token securely. It is shown only once. Set HONMARU_GATEWAY_TOKEN on the trusted machine, then start the gateway.')}</p>
      <textarea className="context-input" readOnly value={token} aria-label={t('Node token')} spellCheck={false} />
      <button className="pill-btn" onClick={() => setToken('')}>{t('I have saved the token')}</button>
    </div></div></div>}
    <div className="rows">{nodes.map(n => <div className="row static" key={n.id}><span className="row-main">{n.name}<span className="row-sub">{n.revokedAt ? t('Revoked') : n.lastSeenAt ? `${t('Last seen')}: ${new Date(n.lastSeenAt).toLocaleString()}` : t('Not connected yet')}</span></span>
      {canManage && !n.revokedAt && (revoke === n.id ? <><button className="pill-btn" disabled={!!busy} onClick={() => void act('revoke', async () => { await api.revokeGateway(n.id); setRevoke(null); await load() })}>{t('Revoke and cancel jobs')}</button><button className="btn-text" onClick={() => setRevoke(null)}>{t('Keep')}</button></> : <button className="btn-text" onClick={() => setRevoke(n.id)}>{t('Revoke')}</button>)}
    </div>)}</div>
    <div className="rows-title">{t('Run JavaScript')}</div>
    <label>{t('Execution node')}<select className="hx-cell-select" value={gatewayId} onChange={e => setGatewayId(e.target.value)}><option value="">—</option>{nodes.filter(n => !n.revokedAt).map(n => <option key={n.id} value={n.id}>{n.name}</option>)}</select></label>
    <label>{t('JavaScript')}<textarea className="context-input" rows={5} value={code} onChange={e => setCode(e.target.value)} spellCheck={false} /></label>
    <label>{t('Input (JSON)')}<textarea className="context-input" rows={2} value={input} onChange={e => setInput(e.target.value)} spellCheck={false} /></label>
    <button className="pill-btn" disabled={!!busy || !gatewayId || !code.trim()} onClick={() => void execute()}>{t('Run')}</button>
    <div className="rows-title">{t('Your execution history')}</div>
    <div className="rows">{jobs.map(j => <div className="row static" key={j.id}><div className="row-main"><span>{t(j.status)} · {new Date(j.createdAt).toLocaleString()}</span>
      {j.result && <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{[j.result.stdout, j.result.stderr, j.result.error].filter(Boolean).join('\n')}</pre>}
      {['queued', 'running'].includes(j.status) && <button className="btn-text" disabled={!!busy} onClick={() => void act('cancel', async () => { await api.cancelExecution(j.id); await load() })}>{t('Cancel')}</button>}
    </div></div>)}</div>
  </Shell>
}
