// Network failures are different from renderer crashes: Electron can leave
// an empty window without a render-process-gone event.
export function installLoadRecovery(contents, { ask, retry, alive, timeoutMs = 30000, record = () => {}, hasContent, inspectionTimeoutMs = 5000, windowState }) {
  const note = (event, code) => { try { record(event, code) } catch {} }
  for (const [event, label] of [['did-start-loading','start'],['did-stop-loading','stop'],['dom-ready','dom'],['unresponsive','unresponsive'],['render-process-gone','gone']]) contents.on(event, () => note(label))
  const reported = new Set()
  contents.on('did-navigate', (_event, _url, status) => {
    if (Number.isInteger(status) && status >= 100 && status <= 599) note('response', status)
  })
  contents.on('preload-error', () => note('preload-error'))
  contents.on('console-message', (details, legacyLevel, legacyMessage) => {
    const level = details?.level ?? (legacyLevel === 3 ? 'error' : undefined)
    if (level !== 'error') return
    if (details?.frame && contents.mainFrame && details.frame !== contents.mainFrame) return
    const message = typeof details?.message === 'string' ? details.message : legacyMessage
    if (typeof message !== 'string') return
    // Classify in memory only. Never persist the message/source URL, which
    // may contain session data, application inputs or third-party content.
    const bounded = message.slice(0, 2000)
    const event = /content security policy|Content-Security-Policy|violates.*directive/i.test(bounded) ? 'policy-error'
      : /dynamically imported module|module script|MIME type|ChunkLoadError/i.test(bounded) ? 'script-load-error'
      : /\b(?:TypeError|ReferenceError|SyntaxError|RangeError)\b/.test(bounded) ? 'javascript-error' : 'script-error'
    if (!reported.has(event)) { reported.add(event); note(event) }
  })
  let generation = 0
  let asking = false
  let timer
  const clear = () => { clearTimeout(timer); timer = undefined }
  const recover = async code => {
    if (asking || !alive()) return
    const failedGeneration = generation
    asking = true
    let again = false
    try {
      note('prompt', code)
      again = await ask(code)
    } catch { /* A window closed while its native dialog was opening. */ }
    finally { asking = false }
    if (again && alive() && failedGeneration === generation) {
      // A retry can fail too; did-fail-load owns the next explanation.
      note('retry', code)
      try { await retry() } catch { /* Already reported by the load event. */ }
    }
  }
  contents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return
    note('navigate')
    reported.clear()
    generation += 1
    clear()
    // A stalled main-frame request need not emit did-fail-load. Never reload
    // automatically: the native prompt leaves the choice with the person.
    timer = setTimeout(() => { timer = undefined; note('timeout', -7); void recover(-7) }, timeoutMs)
    timer.unref?.()
  })
  contents.on('did-finish-load', () => {
    note('finish'); generation += 1; clear()
    if (!hasContent) return
    const loadedGeneration = generation
    // A successful document request does not prove that its UI rendered.
    timer = setTimeout(async () => {
      timer = undefined
      if (!alive() || loadedGeneration !== generation) return
      let inspectionTimer
      try {
        const state = windowState?.()
        if (Number.isInteger(state) && state >= 0 && state <= 15) note('window-state', state)
        note('inspect-start')
        const timedOut = Symbol('inspection timeout')
        const visible = await Promise.race([
          Promise.resolve().then(hasContent),
          new Promise(resolve => { inspectionTimer = setTimeout(() => resolve(timedOut), inspectionTimeoutMs); inspectionTimer.unref?.() }),
        ])
        if (!alive() || loadedGeneration !== generation) return
        if (visible === timedOut) note('inspect-timeout')
        else if (visible === true) note('inspect-visible')
        else if (visible === false) {
          note('blank', -2)
          void recover(-2)
        } else note('inspect-error')
      } catch {
        // Failed or stalled inspection is unknown, never proof of an empty page.
        if (alive() && loadedGeneration === generation) note('inspect-error')
      } finally { clearTimeout(inspectionTimer) }
    }, timeoutMs)
    timer.unref?.()
  })
  contents.on('destroyed', () => { note('destroy'); generation += 1; clear() })
  contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (!isMainFrame) return
    note('fail', code)
    clear()
    // Aborted navigations include deliberately blocked external links.
    if (code !== -3) void recover(code)
  })
}
