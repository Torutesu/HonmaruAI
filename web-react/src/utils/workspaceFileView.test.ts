import {afterEach,expect,test,vi} from 'vitest'
import {readWorkspaceFileView,saveWorkspaceFileView,workspaceFileViewKey} from './workspaceFileView'
afterEach(()=>vi.unstubAllGlobals())
test('file navigation state is scoped by host workspace user and room',()=>{
 const values=new Map<string,string>();vi.stubGlobal('sessionStorage',{getItem:(key:string)=>values.get(key),setItem:(key:string,value:string)=>values.set(key,value)})
 const key=workspaceFileViewKey('host','org','user','room'),state={folderMode:true,directory:'Team/Docs/',search:'roadmap',includeDeleted:true}
 saveWorkspaceFileView(key,state);expect(readWorkspaceFileView(key)).toEqual(state)
 for(const other of [['other','org','user','room'],['host','other','user','room'],['host','org','other','room'],['host','org','user','other']])expect(readWorkspaceFileView(workspaceFileViewKey(...other as [string,string,string,string])).directory).toBe('')
 expect(JSON.parse(values.get(key)!)).toEqual({version:1,...state})
})
test('damaged or unsafe state and unavailable storage fall back without breaking listing',()=>{
 for(const raw of ['{',JSON.stringify({version:1,folderMode:true,directory:'../',search:'',includeDeleted:false}),JSON.stringify({version:2}), 'x'.repeat(8193)]){
  vi.stubGlobal('sessionStorage',{getItem:()=>raw});expect(readWorkspaceFileView('key')).toMatchObject({directory:'',search:'',folderMode:false})
 }
 vi.stubGlobal('sessionStorage',{getItem:()=>{throw Error('denied')},setItem:()=>{throw Error('denied')}})
 expect(readWorkspaceFileView('key').directory).toBe('');expect(()=>saveWorkspaceFileView('key',{directory:'',search:'',folderMode:false,includeDeleted:false})).not.toThrow()
})
