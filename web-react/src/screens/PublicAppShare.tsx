import React, { useEffect, useState } from 'react';
import { CustomAppFrame } from '../components/CustomApp';
import type { Row, Table } from '../utils/harness';
import './SharedThread.css';

type Snapshot = {
  share: { expiresAt: string };
  app: { id: string; name: string; icon: string; version: number };
  html: string;
  table: Table;
  rows: Row[];
};
type LoadState = 'loading' | 'ready' | 'missing' | 'error';

export function PublicAppShare({ httpBase, token }: { httpBase: string; token: string }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const robots = document.createElement('meta');
    robots.name = 'robots'; robots.content = 'noindex,nofollow,noarchive'; document.head.appendChild(robots);
    return () => robots.remove();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => { setState('error'); controller.abort(); }, 15000);
    setSnapshot(null); setState('loading');
    const load = async () => {
      try {
        if (!/^app_[a-f0-9]{64}$/.test(token)) { setState('missing'); return; }
        const response = await fetch(`${httpBase}/app-shares/${token}`, {
          credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal,
        });
        if (response.status === 404) { setState('missing'); return; }
        if (!response.ok) throw new Error('app share');
        const value = await response.json();
        if (typeof value?.app?.name !== 'string' || typeof value?.html !== 'string'
            || value.html.length > 119800 || !Array.isArray(value?.table?.columns)
            || !Array.isArray(value?.rows) || !Number.isFinite(Date.parse(value?.share?.expiresAt))
            || Date.parse(value.share.expiresAt) <= Date.now()) throw new Error('shape');
        setSnapshot(value); setState('ready');
      } catch { if (!controller.signal.aborted) setState('error'); }
      finally { clearTimeout(timeout); }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timeout); };
  }, [httpBase, token, attempt]);

  return <main className="shared-thread public-skill-share public-app-share">
    <header><a href="#/">Honmaru</a><span>共有されたApp</span></header>
    {state === 'loading' && <p role="status">共有されたAppを読み込んでいます…</p>}
    {state === 'missing' && <section><h1>この共有リンクは利用できません</h1><p>期限切れ、無効化、または公開版が更新されたリンクです。</p></section>}
    {state === 'error' && <section role="alert"><h1>Appを読み込めませんでした</h1><button className="pill-btn" onClick={() => setAttempt(value => value + 1)}>再試行</button></section>}
    {state === 'ready' && snapshot && <section className="public-skill-share-card">
      <p className="shared-thread-note">リンクを知っている人が閲覧できます。データの変更や外部処理はできません。</p>
      <h1>{snapshot.app.icon} {snapshot.app.name}</h1>
      <p className="shared-thread-note">App v{snapshot.app.version} · 有効期限 {new Date(snapshot.share.expiresAt).toLocaleString()}</p>
      <CustomAppFrame html={snapshot.html} table={snapshot.table} rows={snapshot.rows} httpBase={httpBase} />
    </section>}
  </main>;
}
