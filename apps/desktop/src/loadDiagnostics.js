import { readFileSync, writeFileSync, statSync } from 'node:fs'
const EVENTS = new Set(['inspect-start', 'inspect-visible', 'inspect-error', 'inspect-timeout', 'window-state', 'policy-error', 'javascript-error', 'response', 'preload-error', 'script-load-error', 'script-error', 'start', 'stop', 'navigate', 'dom', 'finish', 'blank', 'fail', 'timeout', 'prompt', 'retry', 'destroy', 'unresponsive', 'gone'])
// Local, bounded support evidence. Never accept a URL, page text or error
// description. A restart retains the previous load's final events.
export function createLoadDiagnostics(file, version) {
  let events = []
  try {
    if (statSync(file).size <= 32768) {
      const saved = JSON.parse(readFileSync(file, 'utf8'))
      if (Array.isArray(saved)) events = saved.filter(e => e && EVENTS.has(e.event)).map(clean).slice(-63)
    }
  } catch { /* First launch, a damaged file, or unavailable local storage. */ }
  function clean(e) {
    return { at: String(e.at || '').slice(0, 30), version: String(e.version || '').slice(0, 30), event: e.event,
      ...(Number.isInteger(e.code) ? { code: e.code } : {}) }
  }
  return (event, code) => {
    if (!EVENTS.has(event)) return
    events.push(clean({ at: new Date().toISOString(), version, event, code }))
    events = events.slice(-64)
    try { writeFileSync(file, JSON.stringify(events), { mode: 0o600 }) } catch { /* Diagnostics must never prevent loading. */ }
  }
}
