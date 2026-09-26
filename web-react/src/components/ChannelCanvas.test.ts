import { describe, expect, it } from 'vitest'
import { canvasRuns, toggleTask } from './ChannelCanvas'

describe('the canvas', () => {
  const body = '## Opening\n- Unlock at 7\n- [ ] Check the fridge\n- [x] Order milk\nNotes after'

  it('keeps to-dos apart from the rest, by line', () => {
    const runs = canvasRuns(body)
    expect(runs.map((r) => r.kind)).toEqual(['md', 'task', 'task', 'md'])
    expect(runs[1]).toMatchObject({ kind: 'task', line: 2, done: false, text: 'Check the fridge' })
    expect(runs[2]).toMatchObject({ kind: 'task', line: 3, done: true, text: 'Order milk' })
  })

  it('ticks and unticks exactly the line asked for', () => {
    expect(toggleTask(body, 2).split('\n')[2]).toBe('- [x] Check the fridge')
    expect(toggleTask(body, 3).split('\n')[3]).toBe('- [ ] Order milk')
    expect(toggleTask(body, 0)).toBe(body)
  })
})
