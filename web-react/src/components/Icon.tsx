import type { CSSProperties } from 'react'

const paths = {
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4",
  mail: "M3 5h18v14H3V5Zm0 0 9 7 9-7",
  inbox: 'M4 4h16v16H4V4Zm0 10h5l2 3h2l2-3h5',
  send: 'm21 3-7 18-4-7-7-4 18-7ZM10 14 21 3',
  check: 'm5 12 4 4L19 6',
  settings: 'M4 7h16M4 17h16M8 4v6m8 4v6',
  plus: 'M12 5v14M5 12h14',
  arrow: 'M4 12h16m-6-6 6 6-6 6',
  sparkle: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z',
  clock: 'M12 8v4l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  lock: 'M6 10h12v11H6V10Zm2 0V6a4 4 0 0 1 8 0v4',
  up: 'm6 15 6-6 6 6',
  down: 'm6 9 6 6 6-6',
  close: 'm6 6 12 12M6 18 18 6',
} as const

export function Icon({ name, size = 20, style }: { name: keyof typeof paths; size?: number; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}><path d={paths[name]} /></svg>
}

export function BrandMark() {
  return <span className="brand-mark" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M5 5v14M19 5v14M5 12h14M10 8v8M14 8v8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></svg></span>
}
