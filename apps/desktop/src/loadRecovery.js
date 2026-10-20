// Network failures are different from renderer crashes: Electron can leave
// an empty window without a render-process-gone event.
export function installLoadRecovery(contents, { ask, retry, alive, timeoutMs = 30000 }) {
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
      again = await ask(code)
    } catch { /* A window closed while its native dialog was opening. */ }
    finally { asking = false }
    if (again && alive() && failedGeneration === generation) {
      // A retry can fail too; did-fail-load owns the next explanation.
      try { await retry() } catch { /* Already reported by the load event. */ }
    }
  }
  contents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return
    generation += 1
    clear()
    // A stalled main-frame request need not emit did-fail-load. Never reload
    // automatically: the native prompt leaves the choice with the person.
    timer = setTimeout(() => { timer = undefined; void recover(-7) }, timeoutMs)
    timer.unref?.()
  })
  contents.on('did-finish-load', () => { generation += 1; clear() })
  contents.on('destroyed', () => { generation += 1; clear() })
  contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (!isMainFrame) return
    clear()
    // Aborted navigations include deliberately blocked external links.
    if (code !== -3) void recover(code)
  })
}
