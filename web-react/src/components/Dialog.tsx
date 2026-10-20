import React, { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../utils/i18n'
import { Icon } from './Icon'
import './Dialog.css'
import { composing } from '../utils/keys'
import { TAB_STOPS, tabWithin } from '../utils/focusTrap'

interface Props {
  title: string
  /// One line under the title: what this is for. It is the dialog's
  /// description: read out with the title as the dialog opens.
  lede?: React.ReactNode
  /// The id of something in the dialog that says more of what it is about
  /// (which message, which channel), read out after the lede.
  describedBy?: string
  /// Drawn at the top right, beside the title — an illustration, a mark.
  art?: React.ReactNode
  onClose: () => void
  /// The buttons along the bottom. Left out, the dialog has no footer.
  footer?: React.ReactNode
  className?: string
  children: React.ReactNode
}

/// A dialog over whatever is open: a title, what it is for, the form, and
/// the buttons that finish it. Escape and the backdrop close it; focus goes
/// into it when it opens and back where it was when it closes. Focus lands
/// on a field or a button, so a screen reader would say only the title and
/// that: the lede is named as the description, to be read with them — a
/// question like "Delete this? This cannot be undone." is the whole point.
export const Dialog: React.FC<Props> = ({ title, lede, describedBy, art, onClose, footer, className, children }) => {
  const t = useT()
  const box = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  const ledeId = useId()
  const described = [lede ? ledeId : '', describedBy || ''].filter(Boolean).join(' ')
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const stops = () => Array.from(box.current?.querySelectorAll<HTMLElement>(TAB_STOPS) || [])
      .filter(element => !element.matches(':disabled, [hidden], input[type="hidden"]') && element.tabIndex >= 0 && element.getClientRects().length > 0)
    const topmost = () => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"], dialog[open]'))
      return dialogs[dialogs.length - 1] === box.current
    }
    const first = stops().find(element => !element.classList.contains('dialog-close')) || box.current
    first?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (!topmost() || composing(e)) return
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopImmediatePropagation(); close.current()
      } else if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault(); e.stopImmediatePropagation()
        ;(tabWithin(stops(), document.activeElement as HTMLElement | null, e.shiftKey) || box.current)?.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('keydown', onKey, true); before?.focus?.() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Drawn at the top of the page, not inside whatever opened it: a fixed
  // container (the list is one) is a stacking context of its own, and a
  // dialog inside it, however high its z-index, went under the top bar —
  // its title and close button behind the search field (#215).
  return createPortal(
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={box} tabIndex={-1} className={`dialog${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true" aria-label={title} aria-describedby={described || undefined}>
        <div className="dialog-head">
          <div className="dialog-head-text">
            <h2>{title}</h2>
            {lede && <p id={ledeId}>{lede}</p>}
          </div>
          {art}
          <button type="button" className="dialog-close" onClick={onClose} aria-label={t('Close')}><Icon name="x" size={16} /></button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}
