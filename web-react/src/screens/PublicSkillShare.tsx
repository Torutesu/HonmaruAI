import React, { useEffect, useState } from 'react'
import './SharedThread.css'

type SharedSkill = { name: string; description: string; fileCount: number; totalBytes: number; expiresAt: string }
type State = 'loading' | 'ready' | 'missing' | 'error'

export function PublicSkillShare({ httpBase, token }: { httpBase: string; token: string }) {
  const [share, setShare] = useState<SharedSkill | null>(null)
  const [state, setState] = useState<State>('loading')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const robots = document.createElement('meta')
    robots.name = 'robots'; robots.content = 'noindex,nofollow,noarchive'; document.head.appendChild(robots)
    return () => robots.remove()
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => { setState('error'); controller.abort() }, 15000)
    setShare(null); setState('loading')
    const load = async () => {
      try {
        if (!/^skl_[a-f0-9]{64}$/.test(token)) { setState('missing'); return }
        const response = await fetch(`${httpBase}/skill-shares/${token}`, {
          credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal,
        })
        if (response.status === 404) { setState('missing'); return }
        if (!response.ok) throw new Error('share')
        const result = await response.json()
        const value = result.share
        if (typeof value?.name !== 'string' || typeof value?.description !== 'string'
          || !Number.isSafeInteger(value.fileCount) || value.fileCount < 1
          || !Number.isSafeInteger(value.totalBytes) || value.totalBytes < 1
          || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()) throw new Error('shape')
        setShare(value); setState('ready')
      } catch { if (!controller.signal.aborted) setState('error') }
      finally { clearTimeout(timeout) }
    }
    void load()
    return () => { controller.abort(); clearTimeout(timeout) }
  }, [httpBase, token, attempt])

  return <main className="shared-thread public-skill-share">
    <header><a href="#/">Honmaru</a><span>共有されたSkill</span></header>
    {state === 'loading' && <p role="status">共有されたSkillを読み込んでいます…</p>}
    {state === 'missing' && <section><h1>この共有リンクは利用できません</h1><p>期限切れ、無効化、または存在しないリンクです。</p></section>}
    {state === 'error' && <section role="alert"><h1>Skillを読み込めませんでした</h1><button className="pill-btn" onClick={() => setAttempt(value => value + 1)}>再試行</button></section>}
    {state === 'ready' && share && <section className="public-skill-share-card">
      <p className="shared-thread-note">共有リンクから公開されたSkillパッケージです。</p>
      <h1>{share.name}</h1>
      <p className="public-skill-share-description">{share.description}</p>
      <dl><div><dt>ファイル数</dt><dd>{share.fileCount}</dd></div><div><dt>サイズ</dt><dd>{share.totalBytes.toLocaleString()} bytes</dd></div></dl>
      <p className="shared-thread-note">有効期限：{new Date(share.expiresAt).toLocaleString()}</p>
      <div className="public-skill-share-actions">
        <a className="pill-btn quiet" href={`${httpBase}/skill-shares/${token}/download`} referrerPolicy="no-referrer">ZIPをダウンロード</a>
        <a className="pill-btn" href={`#/skill-share/${token}/import`}>Honmaruに非公開コピーを取り込む</a>
      </div>
    </section>}
  </main>
}
