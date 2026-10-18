import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {MessageAppCards} from './MessageAppCards'
import {CustomAppFrame} from './CustomApp'
import {appLinksIn,parseAppLink} from '../utils/appLinks'
import {renderRich} from './MessageParts'
vi.mock('./CustomApp',()=>({CustomAppFrame:()=>null}))
afterEach(()=>vi.unstubAllGlobals())
const body='[Tasks](#/apps/app_tasks/team%3Atest) を作成しました。'
const snapshot={app:{id:'app_tasks',name:'Actual tasks',icon:'📋',version:1,definition:{custom:{published:'<h1>Preview</h1>'}}},table:{name:'Tasks',columns:[]},rows:[{id:'row',values:{title:'Record'}}]}
function globals(){vi.stubGlobal('IntersectionObserver',undefined);vi.stubGlobal('window',{setInterval:vi.fn(),clearInterval:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn(),dispatchEvent:vi.fn()});vi.stubGlobal('document',{visibilityState:'visible',addEventListener:vi.fn(),removeEventListener:vi.fn()})}
test('only canonical links from the current workspace become bounded preview requests',()=>{
 expect(appLinksIn(body+' '+body,'team:test')).toHaveLength(1)
 expect(appLinksIn(body,'different')).toEqual([])
 expect(appLinksIn('[Tasks](https://evil.example/#/apps/app_tasks/team%3Atest)','team:test')).toEqual([])
 expect(parseAppLink('[Bad](#/apps/app%2Fevil/team%3Atest)')).toBeNull()
 expect(parseAppLink('[Bad](#/apps/app_tasks/%ZZ)')).toBeNull()
 expect(appLinksIn(Array.from({length:7},(_,i)=>`[App](#/apps/app_${i}/team%3Atest)`).join(' '),'team:test')).toHaveLength(3)
 const tree=create(<>{renderRich(body,()=> '')}</>)
 expect(tree.root.findByType('a').props.href).toBe('#/apps/app_tasks/team%3Atest');tree.unmount()
})
test('card reads through the viewer API, opens in context, and pins without opening the app',async()=>{
 globals();const api:any={orgId:'team:test',httpBase:'https://api.example',app:vi.fn().mockResolvedValue(snapshot),appPins:vi.fn().mockResolvedValue({pins:[]}),setAppPin:vi.fn().mockResolvedValue({pins:['app_tasks']})},onOpen=vi.fn();let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<MessageAppCards text={body} api={api} onOpen={onOpen}/>,{createNodeMock:()=>({})})})
 expect(api.app).toHaveBeenCalledWith('app_tasks')
 const frame=tree!.root.findByType(CustomAppFrame);expect(frame.props.rows).toBe(snapshot.rows);expect(frame.props.api).toBeUndefined()
 await act(async()=>{tree!.root.findByProps({'aria-label':'Actual tasksをナビゲーションに固定'}).props.onClick()})
 expect(api.setAppPin).toHaveBeenCalledWith('app_tasks',true);expect(onOpen).not.toHaveBeenCalled()
 act(()=>tree!.root.findByProps({'aria-label':'Actual tasksを開く'}).props.onClick());expect(onOpen).toHaveBeenCalledWith('app_tasks')
 act(()=>tree!.unmount())
})
test('a late response from the previous account cannot disclose its preview',async()=>{
 globals();let resolve!:(data:any)=>void;const first:any={orgId:'team:test',httpBase:'https://api.example',app:vi.fn(()=>new Promise(r=>resolve=r))};const next:any={...first,app:vi.fn().mockRejectedValue(new Error('403'))};let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<MessageAppCards text={body} api={first}/>,{createNodeMock:()=>({})})})
 await act(async()=>tree!.update(<MessageAppCards text={body} api={next}/>))
 await act(async()=>resolve(snapshot))
 expect(JSON.stringify(tree!.toJSON())).not.toContain('Actual tasks');expect(tree!.root.findAllByType(CustomAppFrame)).toHaveLength(0);expect(JSON.stringify(tree!.toJSON())).toContain('このアプリを表示できません');act(()=>tree!.unmount())
})
