import React from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import { MessageVisualization, parseMessageVisualization, splitMessageVisualizations, type MessageChart, type MessageExplainer } from './MessageVisualization'

const chart = {
  type: 'chart', title: 'Quarterly revenue', chart: 'bar', categories: ['Q1', 'Q2'],
  series: [{ name: 'North', values: [12, 18] }, { name: 'South', values: [9, 14] }],
} as MessageChart

describe('message visualizations', () => {
  it('accepts bounded chart and explainer schemas', () => {
    expect(parseMessageVisualization(JSON.stringify(chart))?.type).toBe('chart')
    expect(parseMessageVisualization(JSON.stringify({ type: 'explainer', title: 'How it works', sections: [{ title: 'Step 1', body: '**Prepare**' }] }))?.type).toBe('explainer')
    expect(parseMessageVisualization(JSON.stringify({ type: 'illustration', title: 'Flow', description: 'A handoff', elements: [
      { type: 'rect', x: 20, y: 20, width: 300, height: 120, fill: '#6657d9' },
      { type: 'line', x1: 320, y1: 80, x2: 500, y2: 80, stroke: 'currentColor', strokeWidth: 8 },
      { type: 'text', x: 40, y: 90, text: 'Agent A' },
    ] }))?.type).toBe('illustration')
  })

  it('rejects malformed, oversized and executable-looking payloads as visuals', () => {
    expect(parseMessageVisualization('{"type":"chart","title":"x","chart":"bar","categories":["a"],"series":[{"name":"s","values":[null]}]}')).toBeNull()
    expect(parseMessageVisualization(' '.repeat(16_001))).toBeNull()
    expect(parseMessageVisualization(JSON.stringify({ ...chart, html: '<script>alert(1)</script>' }))).toEqual(chart)
    expect(parseMessageVisualization(JSON.stringify({ type: 'illustration', title: 'Unsafe', elements: [{ type: 'image', href: 'https://example.com/x.svg' }] }))).toBeNull()
    expect(parseMessageVisualization(JSON.stringify({ type: 'illustration', title: 'Unsafe', elements: [{ type: 'rect', x: 0, y: 0, width: 20, height: 20, fill: 'url(https://example.com)' }] }))).toBeNull()
    expect(parseMessageVisualization(JSON.stringify({ type: 'illustration', title: 'Unsafe', elements: [{ type: 'text', x: 10, y: 10, text: '<script>x</script>', href: 'javascript:alert(1)' }] }))).toBeNull()
    expect(parseMessageVisualization(JSON.stringify({ type: 'illustration', title: 'Too many', elements: Array.from({ length: 81 }, () => ({ type: 'circle', cx: 10, cy: 10, r: 4 })) }))).toBeNull()
    const segments = splitMessageVisualizations('before\n```honmaru-visual\nnot json\n```\nafter')
    expect(segments).toEqual([{ kind: 'text', text: 'before\n' }, { kind: 'text', text: '```honmaru-visual\nnot json\n```' }, { kind: 'text', text: '\nafter' }])
  })

  it('renders chart data accessibly and supports series and data-view controls', () => {
    let tree!: ReturnType<typeof create>
    act(() => { tree = create(<MessageVisualization value={chart} />) })
    expect(tree.root.findAllByType('svg')).toHaveLength(1)
    expect(tree.root.findAllByType('rect')).toHaveLength(4)
    const north = tree.root.findByProps({ 'aria-label': 'North' })
    act(() => north.props.onClick())
    expect(tree.root.findAllByType('rect')).toHaveLength(2)
    const data = tree.root.findAllByType('button').find(button => button.children.join('') === 'Data')!
    act(() => data.props.onClick())
    expect(tree.root.findAllByType('table')).toHaveLength(1)
  })

  it('keeps untrusted explainer markup as text-only rich content', () => {
    const value: MessageExplainer = { type: 'explainer', title: 'Safe', sections: [{ title: 'Text', body: '<img src=x onerror=alert(1)>' }] }
    let tree!: ReturnType<typeof create>
    act(() => { tree = create(<MessageVisualization value={value} />) })
    expect(tree.root.findAllByType('img')).toHaveLength(0)
    expect(JSON.stringify(tree.toJSON())).toContain('<img')
  })

  it('renders validated illustrations as accessible native SVG without HTML injection', () => {
    const value = parseMessageVisualization(JSON.stringify({ type: 'illustration', title: 'Safe diagram', description: 'A two-step flow', elements: [
      { type: 'rect', x: 20, y: 20, width: 300, height: 120, rx: 20, fill: '#6657d9' },
      { type: 'text', x: 40, y: 90, text: '<img src=x>', fill: '#ffffff' },
    ] }))!
    let tree!: ReturnType<typeof create>
    act(() => { tree = create(<MessageVisualization value={value} />) })
    const svg = tree.root.findByType('svg')
    expect(svg.props.role).toBe('img')
    expect(tree.root.findAllByType('rect')).toHaveLength(1)
    expect(tree.root.findAllByType('img')).toHaveLength(0)
    expect(JSON.stringify(tree.toJSON())).toContain('<img src=x>')
  })
})
