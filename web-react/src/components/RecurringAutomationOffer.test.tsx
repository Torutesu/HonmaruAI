import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test,vi} from 'vitest'
import {RecurringAutomationOffer} from './RecurringAutomationOffer'
vi.mock('../utils/i18n',()=>({useT:()=>((text:string)=>text)}))

test('no workflow request happens until a member accepts, then opens the active Automation',async()=>{
 const fetchMock=vi.fn().mockResolvedValue({ok:true,json:async()=>({offer:{state:'created'},workflow:{id:'wf-active',enabled:true}})})
 vi.stubGlobal('fetch',fetchMock)
 const onOpenWorkflow=vi.fn();let tree:any
 await act(async()=>{tree=create(<RecurringAutomationOffer api={{httpBase:'https://example.test',orgId:'team:one',sessionToken:'session'}} offerId='offer-1' onOpenWorkflow={onOpenWorkflow}/>)})
 expect(fetchMock).not.toHaveBeenCalled()
 const button=(label:string)=>tree.root.findAllByType('button').find((b:any)=>b.children.includes(label))
 await act(async()=>button('Set up').props.onClick())
 expect(fetchMock).toHaveBeenCalledWith('https://example.test/workflows/offers/offer-1/accept',expect.objectContaining({method:'POST'}))
 expect(onOpenWorkflow).toHaveBeenCalledWith('wf-active')
 expect(JSON.stringify(tree.toJSON())).toContain('Automation is active')
 act(()=>tree.unmount());vi.unstubAllGlobals()
})

test('declining is explicit and removes the offer without opening workflow generation',async()=>{
 const fetchMock=vi.fn().mockResolvedValue({ok:true,json:async()=>({offer:{state:'declined'}})})
 vi.stubGlobal('fetch',fetchMock)
 let tree:any;await act(async()=>{tree=create(<RecurringAutomationOffer api={{httpBase:'https://example.test',orgId:'team:one',sessionToken:'session'}} offerId='offer-2'/>)})
 const button=tree.root.findAllByType('button').find((b:any)=>b.children.includes('Not now'))
 await act(async()=>button.props.onClick())
 expect(fetchMock).toHaveBeenCalledWith('https://example.test/workflows/offers/offer-2/decline',expect.objectContaining({method:'POST'}))
 expect(JSON.stringify(tree.toJSON())).toBe('null')
 act(()=>tree.unmount());vi.unstubAllGlobals()
})
