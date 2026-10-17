import { useCallback, useEffect, useState } from 'react'
const EVENT = 'honmaru:app-pins'
export function readAppPins(orgId: string): string[] {
  try { const value = JSON.parse(localStorage.getItem(`hx.appPins:${orgId}`) || '[]'); return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && /^[\w-]{1,80}$/.test(id)).slice(0, 8) : [] } catch { return [] }
}
// Store IDs only. The rail resolves them through the current user's authorized app list.
export function useAppPins(orgId: string) {
  const [pins, setPins] = useState(() => readAppPins(orgId))
  useEffect(() => { const refresh = () => setPins(readAppPins(orgId)); refresh(); window.addEventListener(EVENT, refresh); window.addEventListener('storage', refresh); return () => { window.removeEventListener(EVENT, refresh); window.removeEventListener('storage', refresh) } }, [orgId])
  const toggle = useCallback((id: string) => {
    const current = readAppPins(orgId)
    const next = current.includes(id) ? current.filter(p => p !== id) : [...current.slice(-7), id]
    localStorage.setItem(`hx.appPins:${orgId}`, JSON.stringify(next)); setPins(next); window.dispatchEvent(new Event(EVENT))
  }, [orgId])
  return { pins, toggle }
}
