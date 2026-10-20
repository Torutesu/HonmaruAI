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
