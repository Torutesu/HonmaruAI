import React, { useState } from 'react'
import { Icon } from './Icon'

type PreviewViewport = 'desktop' | 'phone'

/** Adds a responsive-size switch around an app preview. */
export function AppViewportPreview({ children }: { children: React.ReactNode }) {
  const [viewport, setViewport] = useState<PreviewViewport>('desktop')
  return <section className="hx-app-viewport-preview" data-viewport={viewport}>
    <div className="hx-app-viewport-controls" role="group" aria-label="プレビューサイズ">
      <button type="button" aria-label="デスクトップ表示" aria-pressed={viewport === 'desktop'} onClick={() => setViewport('desktop')}><Icon name="monitor" size={16} /></button>
      <button type="button" aria-label="モバイル表示" aria-pressed={viewport === 'phone'} onClick={() => setViewport('phone')}><Icon name="devices" size={16} /></button>
    </div>
    <div className="hx-app-viewport-stage"><div className="hx-app-viewport-frame">{children}</div></div>
  </section>
}
