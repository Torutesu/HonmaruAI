import { expect, test } from 'vitest'
import { ReadWrites } from './readWrites'

test('a delayed read settles before unread is sent and cannot overwrite newer intent', async () => {
  const writes = new ReadWrites()
  let release!: () => void
  const response = new Promise<void>(resolve => { release = resolve })
  const sent: string[] = [], shown: string[] = []
  const read = writes.run('org:room', async latest => {
    sent.push('read'); await response
    if (latest()) shown.push('read')
  })
  const unread = writes.run('org:room', async () => { sent.push('unread'); shown.push('unread') })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(sent).toEqual(['read'])
  release(); await Promise.all([read, unread])
  expect(sent).toEqual(['read', 'unread'])
  expect(shown).toEqual(['unread'])
})

test('another conversation progresses independently and failed writes do not poison the queue', async () => {
  const writes = new ReadWrites()
  let release!: () => void
  const waiting = writes.run('a', () => new Promise<void>(resolve => { release = resolve }))
  expect(await writes.run('b', async () => 'done')).toBe('done')
  release(); await waiting
  await expect(writes.run('a', async () => { throw new Error('network') })).rejects.toThrow('network')
  expect(await writes.run('a', async () => 'unread')).toBe('unread')
})
