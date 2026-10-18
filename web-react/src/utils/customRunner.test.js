import { describe, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import { customRunner } from '../../../worker/src/harness/customRunner.js'

async function runner(renderId = 'current-render') {
  const html = await customRunner().text()
  const listeners = new Map()
  const childListeners = new Map()
  const parent = { postMessage: vi.fn() }
  const child = { contentWindow: { postMessage: vi.fn() }, style: {}, setAttribute: vi.fn(), addEventListener: (type, fn) => childListeners.set(type, fn) }
  runInNewContext(html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>')), {
    parent, addEventListener: (type, fn) => listeners.set(type, fn),
    document: { createElement: () => child, body: { append: vi.fn() } },
  })
  const send = (source, data) => listeners.get('message')({ source, data })
  send(parent, { type: 'honmaru:init', html: '<h1>App</h1>', renderId })
  parent.postMessage.mockClear()
  return { parent, child, childListeners, send, renderId }
}

describe('custom app document readiness', () => {
  it('does not report success from an iframe load alone, including a failed document load', async () => {
    const r = await runner()
    r.childListeners.get('load')?.()
    expect(r.parent.postMessage).not.toHaveBeenCalled()
  })

  it('requires the current child and render token and acknowledges only once', async () => {
    const r = await runner()
    const ready = { type: 'honmaru:document-ready', renderId: r.renderId }
    r.send({}, ready)
    r.send(r.parent, ready)
    r.send(r.child.contentWindow, { ...ready, renderId: 'previous-render' })
    expect(r.parent.postMessage).not.toHaveBeenCalled()
    r.send(r.child.contentWindow, ready)
    r.send(r.child.contentWindow, ready)
    expect(r.parent.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'honmaru:rendered', renderId: r.renderId }, '*')
  })

  it('the actual injected bridge waits for DOM readiness and safely encodes its token', async () => {
    const r = await runner('</script><script>unsafe()')
    const listeners = new Map()
    const parent = { postMessage: vi.fn() }
    const window = {}
    const bridge = r.child.srcdoc.slice(8, r.child.srcdoc.indexOf('</script>'))
    expect(bridge).not.toContain('</script>')
    runInNewContext(bridge, { parent, window, addEventListener: (type, fn) => listeners.set(type, fn) })
    expect(parent.postMessage).not.toHaveBeenCalled()
    expect(typeof window.honmaru.read).toBe('function')
    listeners.get('DOMContentLoaded')()
    expect(parent.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'honmaru:document-ready', renderId: r.renderId }, '*')
  })
})
