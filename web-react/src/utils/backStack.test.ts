import { describe, it, expect } from 'vitest'
import { BackStack } from './backStack'

/// A browser's history, enough of it: entries with an address and a state,
/// and a popstate for every step back or forward.
function browser(start = '#/list') {
  const entries: Array<{ hash: string; state: unknown }> = [{ hash: '#/feed', state: null }, { hash: start, state: null }]
  let at = 1
  const pops: unknown[] = []
  const h = {
    get state() { return entries[at].state },
    pushState(data: unknown) { entries.splice(at + 1); entries.push({ hash: entries[at].hash, state: data }); at += 1 },
    replaceState(data: unknown) { entries[at].state = data },
    replaceAddress(hash: string) { entries[at].hash = hash },
    go(delta: number) { at = Math.max(0, Math.min(entries.length - 1, at + delta)); pops.push(entries[at].state) },
    navigate(hash: string) { entries.splice(at + 1); entries.push({ hash, state: null }); at += 1; pops.push(null) },
    back() { h.go(-1) },
    get hash() { return entries[at].hash },
    pops,
    take() { return pops.splice(0) },
  }
  return h
}

describe('Back in the list', () => {
  it('switches thread URLs at the same pane depth and closes Back on the new thread',()=>{
    const b=browser('#/list'),stack=new BackStack(b,()=>b.hash)
    stack.sync(1)
    b.replaceAddress('#/t/first/team%3Aone');stack.sync(2)
    b.replaceAddress('#/t/second/team%3Aone');stack.sync(2)
    b.back();expect(stack.popped(b.take()[0])).toBe(1)
    b.replaceAddress('#/list');stack.sync(1)
    expect(b.take()).toEqual([]);expect(b.hash).toBe('#/list')
  })

  it('closing an object URL does not traverse back into that object through inherited depth markers', () => {
    const b = browser('#/t/file-thread-f_123')
    const stack = new BackStack(b, () => b.hash)
    stack.sync(2)
    b.replaceAddress('#/list')
    stack.sync(1)
    expect(b.hash).toBe('#/list')
    expect(b.take()).toEqual([])
    b.back()
    expect(stack.popped(b.take()[0])).toBe(1)
    expect(b.hash).toBe('#/list')
  })
  it('closes the member list first, then the conversation, and only then leaves the list', () => {
    const b = browser()
    const stack = new BackStack(b, () => b.hash)
    stack.sync(1) // a conversation, on a phone
    stack.sync(2) // its member list
    b.back()
    expect(stack.popped(b.take()[0])).toBe(1) // the member list closes
    expect(b.hash).toBe('#/list')
    stack.sync(1)
    b.back()
    expect(stack.popped(b.take()[0])).toBe(1) // then the conversation
    expect(b.hash).toBe('#/list')
    stack.sync(0)
    b.back()
    expect(b.hash).toBe('#/feed') // and only then the cards
  })

  it('a pane closed from the app takes its own entry back off, and that step is not taken for Back', () => {
    const b = browser()
    const stack = new BackStack(b, () => b.hash)
    stack.sync(1)
    stack.sync(2)
    stack.sync(1) // the ✕ on the member list
    const [state] = b.take()
    expect(stack.popped(state)).toBe(0)
    expect(stack.pushed).toBe(1)
    b.back()
    expect(stack.popped(b.take()[0])).toBe(1)
    expect(b.hash).toBe('#/list')
  })

  it('one pane swapped for another (a thread for a card) adds nothing to Back', () => {
    const b = browser()
    const stack = new BackStack(b, () => b.hash)
    stack.sync(2)
    stack.sync(2)
    expect(stack.pushed).toBe(2)
    expect(b.take()).toEqual([])
  })

  it('another screen and back by its own link: the list starts again from where it is', () => {
    const b = browser()
    const stack = new BackStack(b, () => b.hash)
    stack.sync(1)
    b.navigate('#/team')
    expect(stack.popped(b.take()[0])).toBe(0) // a change of address is the router's
    b.navigate('#/list')
    b.take()
    stack.sync(2) // a pane opened on top, after coming back
    b.back()
    expect(stack.popped(b.take()[0])).toBe(1)
    expect(b.hash).toBe('#/list')
  })
})
