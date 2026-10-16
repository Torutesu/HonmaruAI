import React from 'react'
import { Icon } from './Icon'
import { useT } from '../utils/i18n'
import type { Screen } from '../utils/route'
import './HarnessWorkspace.css'

export function HarnessRail({ workspace, screen, chat, onChat, onNew, onSearch, onOpen, avatar }: {
  workspace: React.ReactNode; screen: Screen | null; chat: boolean; onChat: () => void; onNew: () => void; onSearch: () => void; onOpen: (screen: Screen) => void; avatar: React.ReactNode
}) {
  const t = useT()
  return <nav className="hx-rail" aria-label={t('Main')}>
    {workspace}
    <button title={t('New message')} aria-label={t('New message')} onClick={onNew}><Icon name="edit" size={18} /></button>
    <button title={t('Search')} aria-label={t('Search')} onClick={onSearch}><Icon name="search" size={18} /></button>
    <span className="hx-rail-rule" />
    <button className={chat ? 'on' : ''} aria-current={chat ? 'page' : undefined} title={t('Chat')} aria-label={t('Chat')} onClick={onChat}><Icon name="message" size={18} /></button>
    <button className={screen === 'agents' || screen === 'hxagents' || screen === 'team' ? 'on' : ''} title={t('Members')} aria-label={t('Members')} onClick={() => onOpen('hxagents')}><Icon name="you" size={18} /></button>
    <details className="hx-rail-resources">
      <summary title={t('Workspace')} aria-label={t('Workspace')}><Icon name="grid" size={18} /></summary>
      <div className="hx-rail-menu">
        {([['home', 'Overview'], ['apps', 'Apps'], ['workflows', 'Workflows'], ['approvals', 'Approvals'], ['skills', 'Skills'], ['gateways', 'Execution nodes'], ['history', 'History'], ['harness', 'Workspace mode']] as [Screen, string][]).map(([key, label]) => <button key={key} onClick={e => { e.currentTarget.closest('details')?.removeAttribute('open'); onOpen(key) }}>{t(label)}</button>)}
      </div>
    </details>
    <div className="hx-rail-spacer" />
    <button className={screen === 'tools' ? 'on' : ''} title={t('Integrations')} aria-label={t('Integrations')} onClick={() => onOpen('tools')}><Icon name="tools" size={18} /></button>
    <button className="hx-rail-avatar" title={t('You')} aria-label={t('You')} onClick={() => onOpen('profile')}>{avatar}</button>
  </nav>
}
