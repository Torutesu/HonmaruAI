import React, { useEffect, useRef, useState } from 'react'
import { Icon, type IconName } from './Icon'
import { hashForApp } from '../utils/route'
import { useAppPins } from '../utils/appPins'
import {useT} from '../utils/i18n'

export function HarnessAppMenu({ appId, orgId, api, onSection, onFloat }: { onFloat?:()=>void; api: import('../utils/harness').HarnessApi; appId: string; orgId: string; onSection: (section: 'overview' | 'data' | 'custom' | 'backend' | 'settings') => void }) {
  const [open, setOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const t=useT()
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const { pins, toggle } = useAppPins(orgId,api)
  useEffect(() => {
    if (!open) return
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  const close = () => { setOpen(false); trigger.current?.focus() }
  const select = (section: Parameters<typeof onSection>[0]) => { onSection(section); close() }
  const item = (label: string, icon: IconName, action: () => void) => <button role="menuitem" onClick={action}><Icon name={icon} size={15} />{label}</button>
  return <div ref={root} className="hx-app-menu" onKeyDown={event => {
    if (event.key === 'Tab') setOpen(false)
    if (event.key === 'Escape') { event.stopPropagation(); close() }
    if (open && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const items = Array.from(root.current!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')); const index = items.indexOf(document.activeElement as HTMLButtonElement)
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
    }
  }}>
    <button ref={trigger} className="hx-app-icon-button" aria-label={t('More app actions')} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(v => !v)}><Icon name="more" size={18} /></button>
    {open && <div className="hx-app-menu-popover" role="menu" aria-label={t('More app actions')}>
      {item(t('Sharing'), 'share', () => select('settings'))}
      {onFloat && item(t('Float over the workspace'), 'external', () => {close();onFloat()})}
      {item(t('Copy app link'), 'link', () => { const url = `${location.origin}/${hashForApp(appId, orgId)}`; navigator.clipboard?.writeText(url).then(() => setNotice(t('Link copied.')), () => setNotice(url)); if (!navigator.clipboard) setNotice(url); close() })}
      {item(pins.includes(appId) ? t('Unpin from navigation') : t('Pin app to navigation'), 'pin', () => { void toggle(appId).then(() => setNotice(t('Navigation synced across your devices.')), () => setNotice(t('Could not save the pin. Check your connection.'))); close() })}
      <div role="separator" />
      {item(t('App overview'), 'grid', () => select('overview'))}
      {item(t('Data viewer'), 'list-check', () => select('data'))}
      {item(t('Runtime'), 'terminal', () => select('backend'))}
      {item(t('Settings and version history'), 'settings', () => select('settings'))}
    </div>}
    {notice && <span role="status" className="hx-app-menu-notice" onClick={() => setNotice('')}>{notice}</span>}
  </div>
}
