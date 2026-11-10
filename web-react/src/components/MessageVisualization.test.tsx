import React from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { MessageVisualization, parseMessageVisualization, splitMessageVisualizations, type MessageChart, type MessageExplainer, type MessageImageJob } from './MessageVisualization'

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
    expect(parseMessageVisualization(JSON.stringify({type:'image_job',title:'Generate an image',jobId:'job-123'}))).toEqual({type:'image_job',title:'Generate an image',jobId:'job-123'})
    expect(parseMessageVisualization(JSON.stringify({type:'image_job',title:'Generate an image',jobId:'job-123',openUrl:'https://evil.example'}))).toBeNull()
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
    expect(tree.root.findAllByType('rect')[0].props.fill).toBe('var(--hx-chart-series-1, #5b4bd7)')
    expect(tree.root.findAllByType('i')[0].props.style.background).toBe('var(--hx-chart-series-1, #5b4bd7)')
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

  it('requires an explicit variable-cost confirmation before approving an image job', async () => {
    const value:MessageImageJob={type:'image_job',title:'Image generation',jobId:'job-123'}
    const originalFetch=globalThis.fetch
    const fetchMock=vi.fn(async (input:RequestInfo|URL,init?:RequestInit)=>{
      const url=String(input)
      if(!init?.method)return new Response(JSON.stringify({job:{status:'awaiting_approval',prompt:'A red bicycle beside a cedar tree',model:'gpt-image-2.6-flare',size:'1024x1024',quality:'low'}}),{status:200})
      expect(url).toContain('/hx/media-jobs/job-123/approve?orgId=org-1')
      expect(JSON.parse(String(init.body))).toEqual({confirmCostVariability:true})
      return new Response(JSON.stringify({job:{status:'succeeded',fileId:'f1',openUrl:'https://honmaru.example/#/c/ag%3Aa?file=f1'}}),{status:200})
    })
    globalThis.fetch=fetchMock as typeof fetch
    let tree!:ReturnType<typeof create>
    try{
      await act(async()=>{tree=create(<MessageVisualization value={value} api={{httpBase:'https://honmaru.example',orgId:'org-1',sessionToken:'session'}}/>);await Promise.resolve()})
      const approve=()=>tree.root.findAllByType('button').find(button=>button.children.join('')==='Approve and generate')!
      expect(approve().props.disabled).toBe(true)
      expect(JSON.stringify(tree.toJSON())).toContain('A red bicycle beside a cedar tree')
      const checkbox=tree.root.findByType('input')
      await act(async()=>{checkbox.props.onChange({target:{checked:true}})})
      expect(approve().props.disabled).toBe(false)
      await act(async()=>{approve().props.onClick();await Promise.resolve();await Promise.resolve()})
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(tree.root.findAllByType('a').some(link=>link.props.href.includes('file=f1'))).toBe(true)
    }finally{globalThis.fetch=originalFetch}
  })
})
