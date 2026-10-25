import { HarnessAppIcon } from '../components/HarnessAppIcon'
import React, { useEffect, useState } from 'react'
import { useT } from '../utils/i18n'
import { Icon, type IconName } from '../components/Icon'
import { hashForCard, hashForView } from '../utils/route'
import type { HomeData, WorkspaceMode } from '../utils/harness'
import type { Business } from '../types/card'
import { useApi, useAct, type HarnessProps, type HarnessScreen } from './HarnessShared'
import { OPEN_APP_KEY } from '../components/RoomApps'

// The harness's home (docs/kylon-gap-plan.md): where a harness workspace
// opens. Not the decision feed: the company at a glance — what waits on you,
// the apps and their numbers, the agents and their roles, the rooms, how the
// workflows last ran, and what is coming back later.

/// Simple or Harness, as two cards: the one in use says so in words and
/// carries the check; the other says what pressing it does.
export function ModePicker({ mode, canEdit, busy, onPick }: { mode: WorkspaceMode; canEdit: boolean; busy: boolean; onPick: (m: WorkspaceMode) => void }) {
  const t = useT()
  const options: Array<{ m: WorkspaceMode; title: string; sub: string; icon: IconName }> = [
    { m: 'simple', title: t('Simple'), sub: t('The decision feed and the chat — Honmaru as it is.'), icon: 'home' },
    { m: 'harness', title: t('Harness'), sub: t('A home for the company: apps, workflows, approvals and agents as members.'), icon: 'zap' },
  ]
  return (
    <div className="hx-modes" role="radiogroup" aria-label={t('Workspace mode')}>
      {options.map((o) => {
        const current = mode === o.m
        return (
          <button
            key={o.m}
            type="button"
            role="radio"
            aria-checked={current}
            data-mode={o.m}
            className={`hx-mode${current ? ' current' : ''}`}
            disabled={current || !canEdit || busy}
            onClick={() => onPick(o.m)}
          >
            <span className="hx-mode-top">
              <span className="hx-mode-icon"><Icon name={o.icon} size={16} /></span>
              <span className="hx-mode-title">{o.title}</span>
              {current && <span className="hx-mode-badge"><Icon name="check" size={12} /> {t('In use')}</span>}
            </span>
            <span className="hx-mode-sub">{o.sub}</span>
            {!current && (
              <span className="hx-mode-action">
                {canEdit ? t('Switch to {mode}', { mode: o.title }) : t('Only an admin can switch')}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="hx-home-sec">
      <div className="hx-home-head"><span className="rows-title">{title}</span>{action}</div>
      {children}
    </section>
  )
}

const ago = (iso: string) => {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000))
  if (min < 60) return `${min}m`
  if (min < 60 * 48) return `${Math.round(min / 60)}h`
  return `${Math.round(min / 1440)}d`
}

export const HarnessHome: React.FC<HarnessProps & {
  businesses: Business[]
  onOpen: (s: HarnessScreen) => void
  onNavigate: (hash: string) => void
  onFeed: () => void
}> = (props) => {
  const t = useT()
  const api = useApi(props)
  const [data, setData] = useState<HomeData | null>(null)
  const [prompt, setPrompt] = useState('')
  const { busy, error, act } = useAct()

  useEffect(() => { void act('load', async () => setData(await api.home())) }, [api, act])

  const openApp = (id: string) => {
    try { sessionStorage.setItem(OPEN_APP_KEY, id) } catch { /* opens the list */ }
    props.onOpen('apps')
  }
  const build = () => act('build', async () => {
    const room = prompt.match(/#([\p{L}\p{N}_-]+)/u)?.[1]
    const made = await api.generate(prompt, room ? `b:${room}` : undefined)
    setPrompt('')
    openApp(made.app.id)
  })

  const empty = data && !data.apps.length && !data.workflows.length && !data.agents.length
  const statusWord = (s: string) => t(s)

  return (
    <div className="screen hx-screen hx-home" data-screen="home">
      <div className="screen-head">
        <span className="head-title">{t('Home')}</span>
        <span className="hx-head-actions">
          <button className="pill-btn quiet" onClick={() => props.onOpen('harness')} data-open="harness"><Icon name="settings" size={14} /> {t('Harness')}</button>
        </span>
      </div>
      <div className="screen-body">
        <div className="hx-home-ask">
          <input
            className="hx-cell-input"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && prompt.trim()) void build() }}
            placeholder={t('Describe an app to build — e.g. an invoice tracker for #ops')}
            aria-label={t('Describe an app')}
          />
          <button className="pill-btn" disabled={!prompt.trim() || busy === 'build'} onClick={() => void build()}>{busy === 'build' ? t('Building…') : t('Build')}</button>
        </div>
        {error && <div className="form-error">{error}</div>}
        {!data && !error && <div className="empty">{t('Loading…')}</div>}

        {data && (
          <div className="hx-home-grid">
            <Section
              title={t('Waiting on you')}
              action={<button className="btn-text" onClick={props.onFeed}>{t('All decisions ({n})', { n: data.approvals.pendingDecisions })}</button>}
            >
              {data.approvals.toDecide.length === 0 ? (
                <div className="hx-home-empty">{data.approvals.pendingDecisions ? t('No agent or workflow is waiting on you. Your other decisions are in the feed.') : t('Nothing is waiting on you.')}</div>
              ) : (
                <div className="rows">
                  {data.approvals.toDecide.slice(0, 5).map((c) => (
                    <a key={c.id} className="row" href={hashForCard(c.id)} data-card={c.id}>
                      <span className="row-icon"><Icon name={c.kind === 'workflow' ? 'zap' : c.kind === 'access' ? 'shield' : 'sparkle'} size={18} /></span>
                      <span className="row-main">{c.title}<span className="row-sub">{[c.source, c.summary].filter(Boolean).join(' · ')}</span></span>
                      <span className="row-value">›</span>
                    </a>
                  ))}
                </div>
              )}
            </Section>

            <Section title={t('Apps')} action={<button className="btn-text" onClick={() => props.onOpen('apps')}>{t('All apps')}</button>}>
              {data.apps.length === 0 ? (
                <div className="hx-home-empty">{t('No apps yet. Describe one above, or start from a template.')}</div>
              ) : (
                <div className="hx-app-grid">
                  {data.apps.map((a) => (
                    <button key={a.id} className="hx-app-tile hx-home-app" onClick={() => openApp(a.id)} data-home-app={a.id}>
                      <span className="hx-app-top"><span className="hx-app-icon" aria-hidden="true"><HarnessAppIcon icon={a.icon} /></span><span className="hx-app-name">{a.name}</span></span>
                      {a.headline ? (
                        <span className="hx-app-figure"><strong>{a.headline.value == null ? '—' : a.headline.value.toLocaleString()}</strong> {a.headline.label}</span>
                      ) : (
                        <span className="hx-app-sub">{t('{n} rows', { n: a.rows })}</span>
                      )}
                      {a.channels.length > 0 && <span className="hx-app-rooms">{a.channels.map((c) => c.replace(/^b:/, '#')).join(' ')}</span>}
                    </button>
                  ))}
                </div>
              )}
            </Section>

            <Section title={t('Agents')} action={<button className="btn-text" onClick={() => props.onOpen('hxagents')}>{t('Agent team')}</button>}>
              {data.agents.length === 0 ? (
                <div className="hx-home-empty">{t('No agents yet. Write one on the Agents screen, then give it a role here.')}</div>
              ) : (
                <div className="rows">
                  {data.agents.slice(0, 6).map((a) => (
                    <a key={a.id} className="row" href={hashForView(`ag:${a.id}`)} data-home-agent={a.id}>
                      <span className="row-icon hx-emoji">{a.emoji || '🤖'}</span>
                      <span className="row-main">{a.name}<span className="row-sub">{a.specialty || a.description || `@${a.handle}`}</span></span>
                      <span className="row-value">{t('Message')}</span>
                    </a>
                  ))}
                </div>
              )}
            </Section>

            <Section title={t('Rooms')}>
              {props.businesses.length === 0 ? (
                <div className="hx-home-empty">{t('No rooms yet.')}</div>
              ) : (
                <div className="rows">
                  {props.businesses.slice(0, 8).map((b) => {
                    const linked = data.apps.filter((a) => a.channels.includes(`b:${b.slug}`))
                    return (
                      <a key={b.slug} className="row" href={hashForView(`b:${b.slug}`)}>
                        <span className="row-icon"><Icon name={b.private ? 'lock' : 'hash'} size={18} /></span>
                        <span className="row-main">{b.name}{linked.length > 0 && <span className="row-sub">{linked.map((a) => `${a.icon} ${a.name}`).join(' · ')}</span>}</span>
                        <span className="row-value">›</span>
                      </a>
                    )
                  })}
                </div>
              )}
            </Section>

            <Section title={t('Workflows')} action={<button className="btn-text" onClick={() => props.onOpen('workflows')}>{t('All workflows')}</button>}>
              {data.workflows.length === 0 ? (
                <div className="hx-home-empty">{t('No workflows yet.')}</div>
              ) : (
                <div className="rows">
                  {data.workflows.slice(0, 6).map((w) => (
                    <button key={w.id} className="row" onClick={() => props.onOpen('workflows')}>
                      <span className="row-icon"><Icon name="zap" size={18} /></span>
                      <span className="row-main">{w.name}{!w.enabled && <span className="hx-off"> · {t('off')}</span>}
                        <span className="row-sub">
                          {w.lastRun ? <><span className={`hx-status ${w.lastRun.status}`}>{statusWord(w.lastRun.status)}</span> · {ago(w.lastRun.startedAt)}</> : t('It has not run yet.')}
                          {w.nextRunAt ? ` · ${t('Next run {when}', { when: new Date(w.nextRunAt).toLocaleString() })}` : ''}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </Section>

            <Section title={t('Follow-ups')}>
              {data.followups.length === 0 ? (
                <div className="hx-home-empty">{t('Nothing scheduled.')}</div>
              ) : (
                <div className="rows">
                  {data.followups.slice(0, 5).map((f) => (
                    <a key={f.id} className="row" href={hashForView(f.channel)}>
                      <span className="row-icon"><Icon name="clock" size={18} /></span>
                      <span className="row-main">{f.instruction}<span className="row-sub">{f.channel.replace(/^b:/, '#')} · {new Date(f.dueAt).toLocaleString()}</span></span>
                    </a>
                  ))}
                </div>
              )}
            </Section>
          </div>
        )}

        {empty && (
          <div className="hx-home-start">
            <div className="rows-title">{t('Get started')}</div>
            <div className="hx-app-grid">
              <button className="hx-app-tile template" onClick={() => props.onOpen('apps')}><span className="hx-app-icon"><Icon name="record" size={20} /></span><span className="hx-app-name">{t('Start an app from a template')}</span><span className="hx-app-sub">{t('A CRM, a hiring board or an invoice tracker, with sample rows.')}</span></button>
              <button className="hx-app-tile template" onClick={() => props.onOpen('workflows')}><span className="hx-app-icon"><Icon name="zap" size={20} /></span><span className="hx-app-name">{t('Make a workflow')}</span><span className="hx-app-sub">{t('When something happens, your AI does the next steps.')}</span></button>
              <button className="hx-app-tile template" onClick={() => props.onNavigate('#/agents')}><span className="hx-app-icon"><Icon name="users" size={20} /></span><span className="hx-app-name">{t('Add an agent')}</span><span className="hx-app-sub">{t('A teammate with a role, a memory and skills.')}</span></button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
