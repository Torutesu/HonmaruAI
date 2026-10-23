// Stable numeric reasons keep native process names, URLs and error strings out
// of the bounded local load log. Zero means an unrecognized future reason.
const REASONS = ['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction']
export function installProcessDiagnostics(app, contents, record) {
  const note = (event, reason) => {
    try { record(event, REASONS.indexOf(reason) + 1) } catch { /* Logging must not affect recovery. */ }
  }
  const childGone = (_event, details) => {
    // Utility services can be unrelated to page rendering; only the GPU is
    // relevant here. Never record serviceName/name or the entire payload.
    if (details?.type === 'GPU') note('gpu-gone', details.reason)
  }
  const rendererGone = (_event, details) => note('renderer-gone', details?.reason)
  app.on('child-process-gone', childGone)
  contents.on('render-process-gone', rendererGone)
  contents.once('destroyed', () => {
    app.removeListener('child-process-gone', childGone)
    contents.removeListener('render-process-gone', rendererGone)
  })
}
