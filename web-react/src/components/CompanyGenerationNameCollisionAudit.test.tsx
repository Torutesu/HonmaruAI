import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test,vi} from 'vitest'
import {CompanyApp} from './CompanyApp'

test('generated name colliding with saved action is reviewed before replacing selected code',async()=>{
 const action={name:'report',version:4,draft:'return "existing"',published:null}
 const api:any={appActions:vi.fn().mockResolvedValue({actions:[action]}),appConnections:vi.fn().mockResolvedValue({connections:[]}),appDatabase:vi.fn().mockResolvedValue({fork:null,version:1,entities:[],migrations:[]}),gateways:vi.fn().mockResolvedValue({gateways:[]}),actionChange:vi.fn().mockResolvedValue({name:'report',code:'return "generated"'})}
 let tree!:ReturnType<typeof create>;await act(async()=>{tree=create(<CompanyApp app={{id:'a',version:1} as any} api={api} canManage reload={()=>{}}/>)})
 act(()=>tree.root.findByProps({placeholder:'例：入力された売上明細から税抜合計と消費税を計算する'}).props.onChange({target:{value:'Create report'}}))
 await act(async()=>{tree.root.findByType('form').props.onSubmit({preventDefault(){}});await Promise.resolve()})
 expect(tree.root.findAllByProps({'aria-label':'生成されたサーバー処理'})).toHaveLength(1)
 expect(tree.root.findByProps({'aria-label':'サーバー処理のコード'}).props.value).toBe('')
 expect(tree.root.findByProps({'aria-label':'同名の保存済み処理'}).props.value).toBe('return "existing"')
 act(()=>tree.unmount())
})

test('refreshing actions after an external edit cannot silently rebase unsaved code',async()=>{
 const old={name:'report',version:1,draft:'return "v1"',published:null},newer={...old,version:2,draft:'return "external"'}
 const conflict=Object.assign(new Error('Action changed. Reload before saving.'),{status:409})
 const api:any={appActions:vi.fn().mockResolvedValueOnce({actions:[old]}).mockResolvedValue({actions:[newer]}),appConnections:vi.fn().mockResolvedValue({connections:[]}),appDatabase:vi.fn().mockResolvedValue({fork:null,version:1,entities:[],migrations:[]}),gateways:vi.fn().mockResolvedValue({gateways:[]}),databaseChange:vi.fn().mockResolvedValue({fork:{}}),actionChange:vi.fn().mockRejectedValue(conflict)}
 let tree!:ReturnType<typeof create>;await act(async()=>{tree=create(<CompanyApp app={{id:'a',version:1} as any} api={api} canManage reload={()=>{}}/>)})
 const button=(text:string)=>tree.root.findAllByType('button').find(b=>b.children.join('')===text)!
 act(()=>button('report · 下書き').props.onClick())
 act(()=>tree.root.findByProps({'aria-label':'サーバー処理のコード'}).props.onChange({target:{value:'return "my edit"'}}))
 act(()=>button('データベース').props.onClick())
 await act(async()=>{button('検証DBを作成').props.onClick();await Promise.resolve();await Promise.resolve()})
 act(()=>button('サーバー処理').props.onClick())
 await act(async()=>{button('処理の下書きを保存').props.onClick();await Promise.resolve()})
 expect(api.actionChange).toHaveBeenCalledWith('a',{action:'draft',name:'report',code:'return "my edit"',version:1})
 expect(tree.root.findByProps({'aria-label':'サーバー処理のコード'}).props.value).toBe('return "my edit"')
 expect(tree.root.findByProps({role:'alert'}).children.join('')).toContain('Action changed')
 act(()=>tree.unmount())
})

test('typing an existing name does not authorize overwriting its saved code',async()=>{
 const action={name:'report',version:4,draft:'return "saved"',published:null},confirm=vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
 vi.stubGlobal('window',{confirm})
 const api:any={appActions:vi.fn().mockResolvedValue({actions:[action]}),appConnections:vi.fn().mockResolvedValue({connections:[]}),appDatabase:vi.fn().mockResolvedValue({fork:null,version:1,entities:[],migrations:[]}),gateways:vi.fn().mockResolvedValue({gateways:[]}),actionChange:vi.fn().mockResolvedValue({saved:true,version:5})}
 let tree!:ReturnType<typeof create>;await act(async()=>{tree=create(<CompanyApp app={{id:'a',version:1} as any} api={api} canManage reload={()=>{}}/>)})
 const button=(text:string)=>tree.root.findAllByType('button').find(b=>b.children.join('')===text)!
 act(()=>tree.root.findByProps({placeholder:'calculate_total'}).props.onChange({target:{value:'report'}}))
 act(()=>tree.root.findByProps({'aria-label':'サーバー処理のコード'}).props.onChange({target:{value:'return "mine"'}}))
 expect(button('処理の下書きを保存').props.disabled).toBe(true)
 expect(tree.root.findByProps({'aria-label':'確認する保存済み処理'}).props.value).toBe('return "saved"')
 act(()=>button('この処理を更新対象にする').props.onClick());expect(button('処理の下書きを保存').props.disabled).toBe(true)
 act(()=>button('この処理を更新対象にする').props.onClick());expect(button('処理の下書きを保存').props.disabled).toBe(false)
 await act(async()=>{button('処理の下書きを保存').props.onClick();await Promise.resolve()})
 expect(api.actionChange).toHaveBeenCalledWith('a',{action:'draft',name:'report',version:4,code:'return "mine"'})
 act(()=>tree.unmount());vi.unstubAllGlobals()
})
