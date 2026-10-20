import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { installLoadRecovery } from '../src/loadRecovery.js'

const settle = () => new Promise(resolve => setTimeout(resolve, 0))
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })
function setup(ask = vi.fn(async () => true)) {
  const contents = new EventEmitter()
  const retry = vi.fn(async () => {})
  const alive = vi.fn(() => true)
  installLoadRecovery(contents, { ask, retry, alive })
  const fail = (code = -105, main = true) => contents.emit('did-fail-load', {}, code, 'private description', 'https://example.com/?secret=hidden', main)
  return { contents, ask, retry, alive, fail }
}
it('offers recovery for a main-frame failure without exposing the URL', async () => {
  const { ask, retry, fail } = setup()
  fail(); await settle()
  expect(ask).toHaveBeenCalledWith(-105)
  expect(retry).toHaveBeenCalledOnce()
})
it('ignores aborted navigation and subframe failures', async () => {
  const { ask, fail } = setup()
  fail(-3); fail(-105, false); await settle()
  expect(ask).not.toHaveBeenCalled()
})
it('does not retry after cancellation', async () => {
  const { retry, fail } = setup(vi.fn(async () => false))
  fail(); await settle()
  expect(retry).not.toHaveBeenCalled()
})
it('does not overwrite a newer navigation or stack dialogs', async () => {
  let resolve
  const { contents, ask, retry, fail } = setup(vi.fn(() => new Promise(r => { resolve = r })))
  fail(); fail()
  expect(ask).toHaveBeenCalledOnce()
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  resolve(true); await settle()
  expect(retry).not.toHaveBeenCalled()
})
it('does not retry a destroyed window', async () => {
  let resolve
  const { alive, retry, fail } = setup(vi.fn(() => new Promise(r => { resolve = r })))
  fail(); alive.mockReturnValue(false); resolve(true); await settle()
  expect(retry).not.toHaveBeenCalled()
})
it('offers one recovery prompt when main-frame loading stalls without an error', async () => {
  vi.useFakeTimers()
  const { contents, ask, retry } = setup(vi.fn(async () => false))
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  await vi.advanceTimersByTimeAsync(29999)
  expect(ask).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(ask).toHaveBeenCalledExactlyOnceWith(-7)
  expect(retry).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(60000)
  expect(ask).toHaveBeenCalledOnce()
})
it.each(['did-finish-load', 'destroyed', 'abort'])('cancels the watchdog on %s', async event => {
  vi.useFakeTimers()
  const { contents, ask, fail } = setup()
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  if (event === 'abort') fail(-3); else contents.emit(event)
  await vi.advanceTimersByTimeAsync(30000)
  expect(ask).not.toHaveBeenCalled()
})
it('does not start the watchdog for hash navigation or embedded frames', async () => {
  vi.useFakeTimers()
  const { contents, ask } = setup()
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
  contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
  await vi.advanceTimersByTimeAsync(30000)
  expect(ask).not.toHaveBeenCalled()
})
it('records a stalled load and recovery without recording navigation payloads', async () => {
  vi.useFakeTimers()
  const contents = new EventEmitter()
  const record = vi.fn()
  const retry = vi.fn(async () => {})
  installLoadRecovery(contents, { record, retry, ask: async () => true, alive: () => true })
  contents.emit('did-start-loading')
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'https://private/?secret=hidden' })
  await vi.advanceTimersByTimeAsync(30000)
  expect(record.mock.calls).toEqual([
    ['start', undefined], ['navigate', undefined], ['timeout', -7], ['prompt', -7], ['retry', -7],
  ])
  expect(retry).toHaveBeenCalledOnce()
  contents.emit('did-finish-load')
})
it('keeps recovery available when diagnostics throws', async () => {
  const contents = new EventEmitter()
  const ask = vi.fn(async () => false)
  installLoadRecovery(contents, { record: () => { throw new Error('disk unavailable') }, retry: vi.fn(), ask, alive: () => true })
  contents.emit('did-fail-load', {}, -105, 'private', 'https://private/', true)
  await settle()
  expect(ask).toHaveBeenCalledExactlyOnceWith(-105)
})
it('offers recovery for a completed but empty application document', async () => {
  vi.useFakeTimers()
  const contents = new EventEmitter(), ask = vi.fn(async () => false), record = vi.fn()
  installLoadRecovery(contents, {ask, record, retry: vi.fn(), alive: () => true, hasContent: async () => false})
  contents.emit('did-finish-load')
  await vi.advanceTimersByTimeAsync(30000)
  expect(ask).toHaveBeenCalledExactlyOnceWith(-2)
  expect(record).toHaveBeenCalledWith('blank', -2)
  await vi.advanceTimersByTimeAsync(60000)
  expect(ask).toHaveBeenCalledOnce()
})
it.each(['visible', 'failed', 'navigated', 'destroyed'])('does not mistake %s content inspection for a blank current page', async mode => {
  vi.useFakeTimers()
  const contents = new EventEmitter(), ask = vi.fn(), inspect = vi.fn(async () => {
    if (mode === 'failed') throw new Error('inspection unavailable')
    if (mode === 'navigated') contents.emit('did-start-navigation', {isMainFrame:true,isSameDocument:false})
    if (mode === 'destroyed') contents.emit('destroyed')
    return mode === 'visible'
  })
  installLoadRecovery(contents, {ask, retry:vi.fn(),alive:()=>true,hasContent:inspect})
  contents.emit('did-finish-load')
  await vi.advanceTimersByTimeAsync(30000)
  expect(inspect).toHaveBeenCalledOnce()
  expect(ask).not.toHaveBeenCalled()
})

it('records only bounded error categories and HTTP status, never private console data', () => {
  const contents = new EventEmitter(), record = vi.fn()
  contents.mainFrame = {}
  installLoadRecovery(contents, { record, ask: vi.fn(), retry: vi.fn(), alive: () => true })
  contents.emit('did-navigate', {}, 'https://private/?token=secret', 403, 'Private status')
  contents.emit('did-navigate', {}, 'file:///private', -1)
  contents.emit('console-message', { level: 'error', frame: contents.mainFrame, message: 'Failed to fetch dynamically imported module https://private/?token=secret' })
  contents.emit('console-message', { level: 'error', frame: contents.mainFrame, message: 'Module script has invalid MIME type with private text' })
  contents.emit('console-message', { level: 'info', message: 'private message' })
  contents.emit('console-message', { level: 'error', frame: {}, message: 'iframe private error' })
  contents.emit('preload-error', {}, '/private/path', new Error('secret'))
  expect(record.mock.calls).toEqual([['response', 403], ['script-load-error', undefined], ['preload-error', undefined]])
  contents.emit('did-start-navigation', {isMainFrame:true,isSameDocument:false})
  contents.emit('console-message', {}, 3, 'Another module script failure: secret')
  expect(record.mock.calls.filter(([name])=>name==='script-load-error')).toHaveLength(2)
  contents.emit('destroyed')
  expect(JSON.stringify(record.mock.calls)).not.toMatch(/private|secret/)
})
