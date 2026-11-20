import React,{useState} from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, test, vi } from 'vitest'
import type { HarnessApi } from '../utils/harness'
import type { Step } from '../utils/harness'
import { WorkflowProgramEditor } from './WorkflowProgramEditor'

vi.mock('../utils/i18n', () => ({ useT: () => (key: string, vars?: Record<string, string | number>) => Object.entries(vars || {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), key) }))
afterEach(() => vi.restoreAllMocks())

const makeStep = (code: string): Step => ({
  type: 'code', code, gatewayId: 'node-1', sourceAppId: 'app-1', sourceEntityId: 'tasks', sourceTableId: 'table-1',
} as Step)
const makeApi = () => ({
  gateways: vi.fn().mockResolvedValue({ gateways: [] }),
  workflowAgents: vi.fn().mockResolvedValue({ agents: [] }),
} as unknown as HarnessApi)
const settleCompiler = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 450)) })
const textContent = (node: any): string => node.children.map((child: any) => typeof child === 'string' ? child : textContent(child)).join('')

test('shows a lazy, non-executing TypeScript transpile preview for valid source', async () => {
  const code = 'const answer: number = 42\nexport default function run() { return answer }'
  const tree = create(<WorkflowProgramEditor api={makeApi()} step={makeStep(code)} onChange={() => {}} />)
  await settleCompiler()
  expect(JSON.stringify(tree.toJSON())).toContain('Syntax check passed. This is not a type check.')
  const preview = tree.root.findByType('details')
  expect(preview.findByType('summary').children.join('')).toBe('Show transpiled JavaScript')
  expect(preview.findByType('code').children.join('')).toContain('const answer = 42')
  expect(preview.findByType('code').children.join('')).not.toContain(': number')
  expect(tree.root.findByType('textarea').props.value).toBe(code)
  act(() => tree.unmount())
})

test('reports syntax diagnostics with a line and column, then clears them after correction', async () => {
  const onChange = vi.fn()
  const api = makeApi()
  let tree!: ReturnType<typeof create>
  const invalid = 'export default function run() {\n  return 1'
  await act(async () => { tree = create(<WorkflowProgramEditor api={api} step={makeStep(invalid)} onChange={onChange} />) })
  await settleCompiler()
  const alert = tree.root.findByProps({ role: 'alert' })
  expect(textContent(alert)).toContain('Fix syntax errors before running this program.')
  expect(textContent(alert)).toMatch(/Line \d+, column \d+/)
  expect(tree.root.findAllByType('details')).toHaveLength(0)

  const corrected = 'export default function run() {\n  return 1\n}'
  await act(async () => {
    tree.root.findByProps({ 'aria-label': 'TypeScript source' }).props.onChange({ target: { value: corrected } })
  })
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ code: corrected, sourceAppId: 'app-1', sourceEntityId: 'tasks', sourceTableId: 'table-1' }))
  await act(async () => { tree.update(<WorkflowProgramEditor api={api} step={{ ...makeStep(invalid), code: corrected }} onChange={onChange} />) })
  await settleCompiler()
  expect(tree.root.findAllByProps({ role: 'alert' })).toHaveLength(0)
  expect(JSON.stringify(tree.toJSON())).toContain('Syntax check passed. This is not a type check.')
  act(() => tree.unmount())
})

test('skips local compilation for source above the runtime byte limit', async () => {
  const code = 'x'.repeat(48001)
  const tree = create(<WorkflowProgramEditor api={makeApi()} step={makeStep(code)} onChange={() => {}} />)
  await settleCompiler()
  expect(tree.root.findByProps({ role: 'alert' }).children.join('')).toBe('Program source exceeds 48 KB.')
  expect(tree.root.findAllByType('details')).toHaveLength(0)
  act(() => tree.unmount())
})

test('lets a Workflow explicitly bind and enable writes for an App connection',async()=>{
 const step=makeStep('import {connection} from "@honmaru/workflow-sdk";')
 const api={...makeApi(),appConnections:vi.fn().mockResolvedValue({connections:[
  {name:'issues',method:'GET',enabled:1,version:1,ownerId:'owner'},
  {name:'create_issue',method:'POST',enabled:1,version:3,ownerId:'owner'},
 ]})} as unknown as HarnessApi
 function Harness(){const [value,setValue]=useState(step);return <WorkflowProgramEditor api={api} step={value} onChange={setValue} sourceApps={[{app:{id:'app-1',name:'Tasks'},entities:[]}]}/>}
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<Harness/>)});await act(async()=>{await Promise.resolve()})
 const include=tree.root.findByProps({'aria-label':'Include connection: create_issue'})
 expect(include.props.disabled).toBe(false);act(()=>include.props.onChange({target:{checked:true}}))
 const allow=tree.root.findByProps({'aria-label':'Allow writes via this connection: create_issue'})
 expect(allow.props.checked).toBe(false);act(()=>allow.props.onChange({target:{checked:true}}))
 expect(tree.root.findByProps({'aria-label':'Allow writes via this connection: create_issue'}).props.checked).toBe(true)
 const instructions=textContent(tree.root.findAllByType('p').find(node=>textContent(node).includes('connection.stageWrite')))
 expect(instructions).toContain('private approval card');expect(instructions).toContain('never retries')
 act(()=>tree.unmount())
})
