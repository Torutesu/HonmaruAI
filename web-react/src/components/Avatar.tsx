import React, { useState } from 'react'

/// A person's face: their photo when they have one, and otherwise the first
/// letter of their name on a colour of its own — the same colour for the
/// same name everywhere, so a glance tells two people apart before a read.
///
/// Decoration to a screen reader: the name is always written beside it.

const TINTS = [
  ['#e8e2ff', '#5b3fd6'], ['#dff3ea', '#1f7a55'], ['#ffe6d5', '#b1521a'], ['#e0efff', '#1f5fa8'],
  ['#fde2ec', '#b0275e'], ['#f1ecd9', '#7a5f12'], ['#e3f4f7', '#1b6f80'], ['#ece6f5', '#6a3f93'],
]

export function tintFor(name: string): [string, string] {
  let h = 0
  for (const ch of name || '?') h = (h * 31 + ch.codePointAt(0)!) >>> 0
  return TINTS[h % TINTS.length] as [string, string]
}

export function initialOf(name: string): string {
  const s = String(name || '').trim()
  return (s ? [...s][0] : '?').toUpperCase()
}

interface Props {
  name: string
  url?: string | null
  size?: number
  className?: string
  /// Rounded square (the chat's people) or circle.
  round?: boolean
}

export const Avatar: React.FC<Props> = ({ name, url, size = 32, className, round = false }) => {
  const [broken, setBroken] = useState(false)
  const [bg, fg] = tintFor(name)
  const style: React.CSSProperties = {
    width: size, height: size, borderRadius: round ? '50%' : Math.max(4, Math.round(size * 0.22)),
    fontSize: Math.max(10, Math.round(size * 0.42)),
  }
  if (url && !broken) {
    return (
      <span className={`avatar-img${className ? ` ${className}` : ''}`} style={style} aria-hidden="true">
        <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
      </span>
    )
  }
  return (
    <span className={`avatar-initial${className ? ` ${className}` : ''}`} style={{ ...style, background: bg, color: fg }} aria-hidden="true">
      {initialOf(name)}
    </span>
  )
}
