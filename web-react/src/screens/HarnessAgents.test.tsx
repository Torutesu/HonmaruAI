import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, test, vi } from 'vitest'
import { HarnessAgents } from './HarnessAgents'
vi.mock('../utils/i18n', () => ({ useT: () => (text: string) => text }))
vi.mock('../utils/mentions', () => ({ useMembers: () => [] }))
vi.mock('../components/AgentAvatar', () => ({ AgentAvatar: () => null }))
vi.mock('../components/Icon', () => ({ Icon: () => null }))
vi.mock('../components/AgentAccessDialog',()=>({AgentAccessDialog:({onClose}:any)=><button data-testid="close-access" onClick={()=>onClose('team')}>Close access</button>}))
vi.mock('../components/AgentPersona',()=>({AgentPersona:()=>null}))

test('closing access reloads the directory and dismisses an agent whose grant was removed',async()=>{
 let visible=true;let tree!:ReturnType<typeof create>
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({agents:visible?[{id:'a',name:'Shared agent',handle:'shared',scope:'team'}]:[],profile:{tier:'standard',people:[],access:'private'},canEdit:false,memories:[],skills:[],followups:[],scopes:[]})})))
 try{
  await act(async()=>{tree=create(<HarnessAgents httpBase="https://example.test" orgId="one" sessionToken="first" onClose={vi.fn()}/>)})
  await act(async()=>tree.root.findByProps({'data-agent':'a'}).props.onClick())
  await act(async()=>tree.root.findAllByType('button').find(n=>n.children.includes('Agent access'))!.props.onClick())
  visible=false
  await act(async()=>tree.root.findByProps({'data-testid':'close-access'}).props.onClick())
  expect(tree.root.findAllByProps({'data-agent':'a'})).toHaveLength(0)
  expect(JSON.stringify(tree.toJSON())).toContain('Choose a member')
 }finally{act(()=>tree?.unmount());vi.unstubAllGlobals()}
})

test('late agent responses cannot populate a different workspace or session', async () => {
  const pending: Array<(value: unknown) => void> = []
  vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => pending.push(resolve))))
  let tree!: ReturnType<typeof create>
  const props = { httpBase: 'https://example.test', orgId: 'one', sessionToken: 'first', onClose: vi.fn() }
  const respond = (index: number, name: string) => pending[index]({ ok: true, json: async () => ({ agents: [{ id: name, name, handle: name }] }) })
  try {
    await act(async () => { tree = create(<HarnessAgents {...props} />) })
    await act(async () => { tree.update(<HarnessAgents {...props} orgId="two" />) })
    await act(async () => { respond(1, 'Current agent') })
    await act(async () => { respond(0, 'Previous agent') })
    expect(JSON.stringify(tree.toJSON())).toContain('Current agent')
    expect(JSON.stringify(tree.toJSON())).not.toContain('Previous agent')
    await act(async () => { tree.update(<HarnessAgents {...props} orgId="two" sessionToken="second" />) })
    expect(JSON.stringify(tree.toJSON())).not.toContain('Current agent')
    await act(async () => { respond(2, 'New session agent') })
    expect(JSON.stringify(tree.toJSON())).toContain('New session agent')
  } finally {
    act(() => tree?.unmount())
    vi.unstubAllGlobals()
  }
})
