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
  })

  it('rejects malformed, oversized and executable-looking payloads as visuals', () => {
    expect(parseMessageVisualization('{"type":"chart","title":"x","chart":"bar","categories":["a"],"series":[{"name":"s","values":[null]}]}')).toBeNull()
    expect(parseMessageVisualization(' '.repeat(16_001))).toBeNull()
    expect(parseMessageVisualization(JSON.stringify({ ...chart, html: '<script>alert(1)</script>' }))).toEqual(chart)
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
})
