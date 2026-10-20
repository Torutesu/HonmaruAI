// Network failures are different from renderer crashes: Electron can leave
// an empty window without a render-process-gone event.
export function installLoadRecovery(contents, { ask, retry, alive, timeoutMs = 30000, record = () => {}, hasContent }) {
  const note = (event, code) => { try { record(event, code) } catch {} }
  for (const [event, label] of [['did-start-loading','start'],['did-stop-loading','stop'],['dom-ready','dom'],['unresponsive','unresponsive'],['render-process-gone','gone']]) contents.on(event, () => note(label))
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
      try {
        const visible = await hasContent()
        if (visible === false && alive() && loadedGeneration === generation) {
          note('blank', -2)
          void recover(-2)
        }
      } catch { /* A failed inspection is not proof of an empty page. */ }
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
