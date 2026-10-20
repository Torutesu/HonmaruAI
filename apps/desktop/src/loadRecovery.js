// Network failures are different from renderer crashes: Electron can leave
// an empty window without a render-process-gone event.
export function installLoadRecovery(contents, { ask, retry, alive }) {
  let generation = 0
  let asking = false
  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) generation += 1
  })
  contents.on('did-finish-load', () => { generation += 1 })
  contents.on('did-fail-load', async (_event, code, _description, _url, isMainFrame) => {
    // Aborted navigations include deliberately blocked external links.
    if (!isMainFrame || code === -3 || asking || !alive()) return
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
  })
}
