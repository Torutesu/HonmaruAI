import React, { useEffect, useId, useRef, useState } from 'react'
import { Icon } from './Icon'
import { useT } from '../utils/i18n'
import { composing } from '../utils/keys'
import './AgentTierSelect.css'

export type AgentTier = 'lite' | 'standard' | 'max'
const tiers: AgentTier[] = ['lite', 'standard', 'max']
const names = { lite: 'Fast', standard: 'Pro', max: 'Max' }
const hints = { lite: 'For editing, summaries and simple everyday tasks.', standard: 'For everyday work that balances capability and speed.', max: 'For complex development, design and demanding tasks.' }

export function AgentTierSelect({ value, onChange, disabled = false, compact = false }: {
  value: AgentTier; onChange: (value: AgentTier) => void; disabled?: boolean; compact?: boolean
}) {
  const t = useT(), id = useId()
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null)
  const [position, setPosition] = useState<React.CSSProperties>({})
  const [open, setOpen] = useState(false), [active, setActive] = useState(0), [above, setAbove] = useState(false)
  const close = () => setOpen(false)
  const show = () => {
    if (disabled) return
    const rect = trigger.current?.getBoundingClientRect()
    const up = !!rect && window.innerHeight - rect.bottom < 280 && rect.top > 280
    setAbove(up)
    if (rect) {
      const width = Math.min(compact ? 360 : rect.width, window.innerWidth - 24)
      setPosition({ width, left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        top: up ? rect.top - 4 : rect.bottom + 4, transform: up ? 'translateY(-100%)' : undefined,
        maxHeight: Math.max(80, Math.min(260, up ? rect.top - 16 : window.innerHeight - rect.bottom - 16)) })
    }
    setActive(Math.max(0, tiers.indexOf(value))); setOpen(true)
  }
  const choose = (tier: AgentTier) => { if (disabled) return; close(); trigger.current?.focus(); if (tier !== value) onChange(tier) }
  useEffect(() => { if (disabled) close() }, [disabled])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close() }
    // Run before the parent dialog's document capture handler: Escape closes
    // the list first, while a second Escape can close the surrounding dialog.
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !composing(event) && root.current?.contains(event.target as Node)) {
        event.preventDefault(); event.stopImmediatePropagation(); close(); trigger.current?.focus()
      }
    }
    const reposition = (event: Event) => { if (event.target === window || !root.current?.contains(event.target as Node)) close() }
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('keydown', escape, true)
    return () => { window.removeEventListener('resize', reposition); window.removeEventListener('scroll', reposition, true); document.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', escape, true) }
  }, [open])
  return <div ref={root} className={`hx-tier-select${compact ? ' compact' : ''}`} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node)) close()
  }}>
    <button ref={trigger} type="button" className="hx-tier-trigger" disabled={disabled} role="combobox"
      aria-label={t('Intelligence')} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined}
      aria-activedescendant={open ? `${id}-${tiers[active]}` : undefined}
      onClick={() => open ? close() : show()} onKeyDown={event => {
        if (disabled || composing(event)) return
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          if (!open) { show(); return }
          setActive(current => event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (current + (event.key === 'ArrowDown' ? 1 : 2)) % 3)
        } else if (open && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); choose(tiers[active]) }
        else if (event.key === 'Tab') close()
      }}>
      <span><strong>{t(names[value])}</strong>{!compact && <small>{t(hints[value])}</small>}</span><Icon name="chevron-down" size={14}/>
    </button>
    {open && <div id={id} style={position} role="listbox" aria-label={t('Intelligence')} className={`hx-tier-options${above ? ' above' : ''}`}>
      {tiers.map((tier, index) => <button key={tier} type="button" role="option" id={`${id}-${tier}`} tabIndex={-1}
        aria-selected={tier === value} className={index === active ? 'active' : ''}
        onMouseDown={event => event.preventDefault()} onMouseMove={() => setActive(index)} onClick={() => choose(tier)}>
        <span><strong>{t(names[tier])}</strong><small>{t(hints[tier])}</small></span>
        {tier === value && <Icon name="check" size={14}/>}
      </button>)}
    </div>}
  </div>
}
