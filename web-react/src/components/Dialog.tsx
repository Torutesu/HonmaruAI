import React, { useEffect, useRef } from 'react'
import { useT } from '../utils/i18n'
import { Icon } from './Icon'
import './Dialog.css'

interface Props {
  title: string
  /// One line under the title: what this is for.
  lede?: React.ReactNode
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
/// into it when it opens and back where it was when it closes.
export const Dialog: React.FC<Props> = ({ title, lede, art, onClose, footer, className, children }) => {
  const t = useT()
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const first = box.current?.querySelector<HTMLElement>('input, textarea, select, button:not(.dialog-close)')
    first?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('keydown', onKey, true); before?.focus?.() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={box} className={`dialog${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="dialog-head">
          <div className="dialog-head-text">
            <h2>{title}</h2>
            {lede && <p>{lede}</p>}
          </div>
          {art}
          <button type="button" className="dialog-close" onClick={onClose} aria-label={t('Close')}><Icon name="x" size={16} /></button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  )
}
