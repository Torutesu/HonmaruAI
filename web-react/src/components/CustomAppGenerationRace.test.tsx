import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {CustomAppEditor} from './CustomApp'
vi.mock('../utils/appearance',()=>({useAppearance:()=>({theme:'light'})}))
afterEach(()=>vi.unstubAllGlobals())
const table:any={id:'table',name:'Tasks',columns:[]}
const app=(id='app',draft='',version=1):any=>({id,version,definition:{custom:{draft,published:''}}})
const defer=()=>{let resolve!:(value:any)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<any>((ok,no)=>{resolve=ok;reject=no});return {promise,resolve,reject}}
const apiWith=(generateCustom:any)=>({generateCustom,saveCustom:vi.fn().mockResolvedValue({}),appDatabase:vi.fn().mockRejectedValue(new Error('preview unavailable')),versions:vi.fn().mockResolvedValue({versions:[]})})
const render=(item:any,api:any,reload=vi.fn())=><CustomAppEditor app={item} table={table} rows={[]} api={api} reload={reload} httpBase="https://api.example"/>
const area=(tree:ReturnType<typeof create>,name:string)=>tree.root.findByProps({'aria-label':name})
const button=(tree:ReturnType<typeof create>,name:string)=>tree.root.findAllByType('button').find(b=>b.children.includes(name))!
const change=(tree:ReturnType<typeof create>,name:string,value:string)=>act(()=>area(tree,name).props.onChange({target:{value}}))
const generate=(tree:ReturnType<typeof create>)=>act(()=>tree.root.findByType('form').props.onSubmit({preventDefault:vi.fn()}))

test('unchanged editor applies a valid generated result without saving or publishing',async()=>{
 vi.stubGlobal('window',{confirm:vi.fn(()=>true)});const pending=defer(),api=apiWith(vi.fn(()=>pending.promise));let tree:ReturnType<typeof create>
 act(()=>{tree=create(render(app(),api))});change(tree!,'作りたいカスタムアプリ','Make a dashboard');generate(tree!)
 await act(async()=>{pending.resolve({html:'<p>Generated</p>'});await pending.promise})
 expect(area(tree!,'カスタムアプリのソース').props.value).toBe('<p>Generated</p>');expect(tree!.root.findAllByProps({'aria-label':'生成されたコード'})).toHaveLength(0);expect(api.saveCustom).not.toHaveBeenCalled();act(()=>tree!.unmount())
})

test('intervening edits including same-text restore keep both code and original request until a decision',async()=>{
 const confirm=vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);vi.stubGlobal('window',{confirm});const pending=defer(),api=apiWith(vi.fn(()=>pending.promise));let tree:ReturnType<typeof create>
 act(()=>{tree=create(render(app(),api))});change(tree!,'カスタムアプリのソース','A');change(tree!,'作りたいカスタムアプリ','Original request');generate(tree!)
 change(tree!,'カスタムアプリのソース','B');change(tree!,'カスタムアプリのソース','A');change(tree!,'作りたいカスタムアプリ','Different request')
 await act(async()=>{pending.resolve({html:'<p>Generated</p>'});await pending.promise})
 expect(area(tree!,'カスタムアプリのソース').props.value).toBe('A');expect(area(tree!,'生成されたコード').props.value).toBe('<p>Generated</p>');expect(area(tree!,'生成時の依頼').props.value).toBe('Original request')
 generate(tree!);expect(api.generateCustom).toHaveBeenCalledOnce();expect(button(tree!,'自然文からコードを生成').props.disabled).toBe(true)
 act(()=>button(tree!,'生成結果を採用').props.onClick());expect(area(tree!,'カスタムアプリのソース').props.value).toBe('A');expect(area(tree!,'生成されたコード')).toBeTruthy()
 act(()=>button(tree!,'生成結果を採用').props.onClick());expect(area(tree!,'カスタムアプリのソース').props.value).toBe('<p>Generated</p>');expect(api.saveCustom).not.toHaveBeenCalled();act(()=>tree!.unmount())
})

test('a changed server draft keeps local code, shows both values, and blocks save until explicit choice',async()=>{
 vi.stubGlobal('window',{confirm:vi.fn(()=>true)});const pending=defer(),api=apiWith(vi.fn(()=>pending.promise));let tree:ReturnType<typeof create>
 act(()=>{tree=create(render(app('app','server old'),api))});change(tree!,'カスタムアプリのソース','local edit');change(tree!,'作りたいカスタムアプリ','Make');generate(tree!)
 act(()=>tree!.update(render(app('app','server new',2),api)))
 expect(area(tree!,'カスタムアプリのソース').props.value).toBe('local edit');expect(area(tree!,'現在保存されているコード').props.value).toBe('server new');expect(button(tree!,'下書きを保存').props.disabled).toBe(true)
 await act(async()=>{pending.resolve({html:'generated'});await pending.promise})
 expect(area(tree!,'生成されたコード').props.value).toBe('generated');expect(api.saveCustom).not.toHaveBeenCalled()
 act(()=>button(tree!,'編集中のコードで続ける').props.onClick());await act(async()=>{button(tree!,'下書きを保存').props.onClick();await Promise.resolve()})
 expect(api.saveCustom).toHaveBeenCalledWith('app','draft',2,'local edit');act(()=>tree!.unmount())
})

test('prompt edits during generation keep the generated code and the original request separate',async()=>{
 vi.stubGlobal('window',{confirm:vi.fn(()=>true)});const pending=defer(),api=apiWith(vi.fn(()=>pending.promise));let tree:ReturnType<typeof create>
 act(()=>{tree=create(render(app(),api))});change(tree!,'作りたいカスタムアプリ','First prompt');generate(tree!);change(tree!,'作りたいカスタムアプリ','Second prompt')
 await act(async()=>{pending.resolve({html:'result'});await pending.promise})
 expect(area(tree!,'作りたいカスタムアプリ').props.value).toBe('Second prompt');expect(area(tree!,'生成時の依頼').props.value).toBe('First prompt');expect(area(tree!,'生成されたコード').props.value).toBe('result');expect(area(tree!,'カスタムアプリのソース').props.value).toBe('');expect(api.saveCustom).not.toHaveBeenCalled();act(()=>tree!.unmount())
})

test('failed generation keeps code and prompt and allows another request',async()=>{
 vi.stubGlobal('window',{confirm:vi.fn(()=>true)});const pending=defer(),api=apiWith(vi.fn(()=>pending.promise));let tree:ReturnType<typeof create>
 act(()=>{tree=create(render(app(),api))});change(tree!,'カスタムアプリのソース','draft');change(tree!,'作りたいカスタムアプリ','request');generate(tree!)
 await act(async()=>{pending.reject(new Error('generation failed'));await pending.promise.catch(()=>{})})
 expect(area(tree!,'カスタムアプリのソース').props.value).toBe('draft');expect(area(tree!,'作りたいカスタムアプリ').props.value).toBe('request');expect(tree!.root.findByProps({role:'alert'}).children).toContain('generation failed');expect(button(tree!,'自然文からコードを生成').props.disabled).toBe(false);act(()=>tree!.unmount())
})

test('a clean editor follows a newer saved draft without a conflict',()=>{
 vi.stubGlobal('window',{confirm:vi.fn(()=>true)});const api=apiWith(vi.fn());let tree:ReturnType<typeof create>
 act(()=>{tree=create(render(app('app','old'),api))});act(()=>tree!.update(render(app('app','new',2),api)))
 expect(area(tree!,'カスタムアプリのソース').props.value).toBe('new');expect(tree!.root.findAllByProps({'aria-label':'現在保存されているコード'})).toHaveLength(0);act(()=>tree!.unmount())
})

test.each(['resolve','reject'] as const)('late generation %s does not affect a different app or API',async outcome=>{
 vi.stubGlobal('window',{confirm:vi.fn(()=>true)});const pending=defer(),oldApi=apiWith(vi.fn(()=>pending.promise)),newApi=apiWith(vi.fn());let tree:ReturnType<typeof create>
 act(()=>{tree=create(render(app('old','old draft'),oldApi))});change(tree!,'作りたいカスタムアプリ','Old request');generate(tree!)
 act(()=>tree!.update(render(app('new','new draft'),newApi)))
 await act(async()=>{if(outcome==='resolve')pending.resolve({html:'old result'});else pending.reject(new Error('old error'));await pending.promise.catch(()=>{})})
 expect(area(tree!,'カスタムアプリのソース').props.value).toBe('new draft');expect(tree!.root.findAllByProps({'aria-label':'生成されたコード'})).toHaveLength(0);expect(tree!.root.findAllByProps({role:'alert'}).some(node=>node.children.includes('old error'))).toBe(false);expect(button(tree!,'自然文からコードを生成').props.disabled).toBe(true);act(()=>tree!.unmount())
})

test.each(['app','account'] as const)('a late response is fenced when only %s changes',async kind=>{
 vi.stubGlobal('window',{confirm:vi.fn(()=>true)});const pending=defer(),oldApi=apiWith(vi.fn(()=>pending.promise)),otherApi=apiWith(vi.fn());let tree:ReturnType<typeof create>
 act(()=>{tree=create(render(app('same','old'),oldApi))});change(tree!,'作りたいカスタムアプリ','Make');generate(tree!)
 act(()=>tree!.update(render(app(kind==='app'?'other':'same','new'),kind==='app'?oldApi:otherApi)))
 await act(async()=>{pending.resolve({html:'old result'});await pending.promise})
 expect(area(tree!,'カスタムアプリのソース').props.value).toBe('new');expect(tree!.root.findAllByProps({'aria-label':'生成されたコード'})).toHaveLength(0);act(()=>tree!.unmount())
})

test.each([{}, {html:''}, {html:'x'.repeat(120001)}])('invalid generation response preserves local code',async response=>{
 vi.stubGlobal('window',{confirm:vi.fn(()=>true)});const api=apiWith(vi.fn().mockResolvedValue(response));let tree:ReturnType<typeof create>
 act(()=>{tree=create(render(app(),api))});change(tree!,'カスタムアプリのソース','local');change(tree!,'作りたいカスタムアプリ','Make')
 await act(async()=>{generate(tree!);await Promise.resolve();await Promise.resolve()})
 expect(area(tree!,'カスタムアプリのソース').props.value).toBe('local');expect(tree!.root.findByProps({role:'alert'})).toBeTruthy();expect(api.saveCustom).not.toHaveBeenCalled();act(()=>tree!.unmount())
})

test('a reverted edit remains protected when the saved draft changes during generation',async()=>{
 vi.stubGlobal('window',{confirm:vi.fn(()=>true)});const pending=defer(),api=apiWith(vi.fn(()=>pending.promise));let tree:ReturnType<typeof create>
 act(()=>{tree=create(render(app('app','old'),api))});change(tree!,'作りたいカスタムアプリ','Make');generate(tree!);change(tree!,'カスタムアプリのソース','other');change(tree!,'カスタムアプリのソース','old');act(()=>tree!.update(render(app('app','new',2),api)))
 expect(area(tree!,'カスタムアプリのソース').props.value).toBe('old');expect(area(tree!,'現在保存されているコード').props.value).toBe('new');expect(button(tree!,'下書きを保存').props.disabled).toBe(true)
 await act(async()=>{pending.resolve({html:'generated'});await pending.promise})
 expect(area(tree!,'生成されたコード').props.value).toBe('generated');expect(api.saveCustom).not.toHaveBeenCalled();act(()=>tree!.unmount())
})

test('a context change warns before adopting a generated result',async()=>{
 const confirm=vi.fn((_message:string)=>false);vi.stubGlobal('window',{confirm});const pending=defer(),api=apiWith(vi.fn(()=>pending.promise));let tree:ReturnType<typeof create>
 act(()=>{tree=create(render(app('app','old'),api))});change(tree!,'作りたいカスタムアプリ','Make');generate(tree!);change(tree!,'カスタムアプリのソース','edited')
 await act(async()=>{pending.resolve({html:'generated'});await pending.promise});act(()=>tree!.update(render(app('app','old',2),api)))
 act(()=>button(tree!,'生成結果を採用').props.onClick());expect(confirm.mock.calls[0][0]).toContain('生成時のバージョン 1');expect(area(tree!,'カスタムアプリのソース').props.value).toBe('edited');expect(area(tree!,'生成されたコード').props.value).toBe('generated');expect(api.saveCustom).not.toHaveBeenCalled();act(()=>tree!.unmount())
})

test('a later edit survives a saved draft refresh and requires explicit conflict resolution',async()=>{
 vi.stubGlobal('window',{confirm:vi.fn(()=>true)});const pending=defer(),api=apiWith(vi.fn());api.saveCustom=vi.fn(()=>pending.promise);let tree:ReturnType<typeof create>
 act(()=>{tree=create(render(app('app','old'),api))});change(tree!,'カスタムアプリのソース','saved A');act(()=>button(tree!,'下書きを保存').props.onClick());change(tree!,'カスタムアプリのソース','later B')
 await act(async()=>{pending.resolve({});await pending.promise});act(()=>tree!.update(render(app('app','saved A',2),api)))
 expect(area(tree!,'カスタムアプリのソース').props.value).toBe('later B');expect(area(tree!,'現在保存されているコード').props.value).toBe('saved A');expect(button(tree!,'下書きを保存').props.disabled).toBe(true);expect(api.saveCustom).toHaveBeenCalledOnce();act(()=>tree!.unmount())
})

test('choosing a newer saved draft allows subsequent clean refreshes',()=>{
 vi.stubGlobal('window',{confirm:vi.fn(()=>true)});const api=apiWith(vi.fn());let tree:ReturnType<typeof create>
 act(()=>{tree=create(render(app('app','old'),api))});change(tree!,'カスタムアプリのソース','local');act(()=>tree!.update(render(app('app','new',2),api)));act(()=>button(tree!,'保存済みコードを使う').props.onClick());act(()=>tree!.update(render(app('app','newer',3),api)))
 expect(area(tree!,'カスタムアプリのソース').props.value).toBe('newer');expect(tree!.root.findAllByProps({'aria-label':'現在保存されているコード'})).toHaveLength(0);act(()=>tree!.unmount())
})

test('a version change while generating prevents automatic application',async()=>{
 vi.stubGlobal('window',{confirm:vi.fn(()=>true)});const pending=defer(),api=apiWith(vi.fn(()=>pending.promise));let tree:ReturnType<typeof create>
 act(()=>{tree=create(render(app('app','old'),api))});change(tree!,'作りたいカスタムアプリ','Make');generate(tree!);act(()=>tree!.update(render(app('app','old',2),api)))
 await act(async()=>{pending.resolve({html:'generated'});await pending.promise});expect(area(tree!,'カスタムアプリのソース').props.value).toBe('old');expect(area(tree!,'生成されたコード').props.value).toBe('generated');act(()=>tree!.unmount())
})

test('a stale response cannot clear the busy state of another app request',async()=>{
 vi.stubGlobal('window',{confirm:vi.fn(()=>true)});const oldPending=defer(),newPending=defer(),oldApi=apiWith(vi.fn(()=>oldPending.promise)),newApi=apiWith(vi.fn(()=>newPending.promise));let tree:ReturnType<typeof create>
 act(()=>{tree=create(render(app('old','old draft'),oldApi))});change(tree!,'作りたいカスタムアプリ','Old');generate(tree!);act(()=>tree!.update(render(app('new','new draft'),newApi)));change(tree!,'作りたいカスタムアプリ','New');generate(tree!)
 await act(async()=>{oldPending.resolve({html:'old result'});await oldPending.promise});expect(button(tree!,'処理中…').props.disabled).toBe(true);expect(area(tree!,'カスタムアプリのソース').props.value).toBe('new draft')
 await act(async()=>{newPending.resolve({html:'new result'});await newPending.promise});expect(area(tree!,'カスタムアプリのソース').props.value).toBe('new result');expect(oldApi.saveCustom).not.toHaveBeenCalled();expect(newApi.saveCustom).not.toHaveBeenCalled();act(()=>tree!.unmount())
})

test('strict mode allows an unchanged generation to apply normally',async()=>{
 vi.stubGlobal('window',{confirm:vi.fn(()=>true)});const pending=defer(),api=apiWith(vi.fn(()=>pending.promise));let tree:ReturnType<typeof create>
 act(()=>{tree=create(<React.StrictMode>{render(app('app','old'),api)}</React.StrictMode>)});change(tree!,'作りたいカスタムアプリ','Make');generate(tree!)
 await act(async()=>{pending.resolve({html:'generated'});await pending.promise});expect(area(tree!,'カスタムアプリのソース').props.value).toBe('generated');expect(api.saveCustom).not.toHaveBeenCalled();act(()=>tree!.unmount())
})

test('a clean saved draft update preserves the starting editor code separately from the latest saved code and result',async()=>{
 vi.stubGlobal('window',{confirm:vi.fn(()=>true)});const pending=defer(),api=apiWith(vi.fn(()=>pending.promise));let tree:ReturnType<typeof create>
 act(()=>{tree=create(render(app('app','original'),api))});change(tree!,'作りたいカスタムアプリ','Make');generate(tree!);act(()=>tree!.update(render(app('app','new saved',2),api)))
 await act(async()=>{pending.resolve({html:'generated'});await pending.promise});expect(area(tree!,'カスタムアプリのソース').props.value).toBe('new saved');expect(area(tree!,'生成開始時の編集中コード').props.value).toBe('original');expect(area(tree!,'生成されたコード').props.value).toBe('generated');expect(api.saveCustom).not.toHaveBeenCalled();act(()=>tree!.unmount())
})
