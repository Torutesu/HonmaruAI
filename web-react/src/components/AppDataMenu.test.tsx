import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {AppDataMenu} from './AppDataMenu'
afterEach(()=>vi.unstubAllGlobals())
test('wrap toggle reports save failure and retries without falsely changing checked state',async()=>{
 vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()});const save=vi.fn().mockRejectedValueOnce(new Error('競合')).mockResolvedValue(undefined);let tree:ReturnType<typeof create>
 act(()=>{tree=create(<AppDataMenu wrapText={false} save={save}/>)});act(()=>tree!.root.findByProps({'aria-label':'その他のデータビューアー操作'}).props.onClick());await act(async()=>{tree!.root.findByProps({role:'menuitemcheckbox'}).props.onClick();await Promise.resolve()});expect(save).toHaveBeenCalledWith(true);expect(tree!.root.findByProps({role:'menuitemcheckbox'}).props['aria-checked']).toBe(false);expect(tree!.root.findByProps({role:'alert'}).children).toContain('競合');await act(async()=>{tree!.root.findByProps({role:'menuitemcheckbox'}).props.onClick();await Promise.resolve()});expect(tree!.root.findAllByProps({role:'menu'})).toHaveLength(0);act(()=>tree!.unmount())
})
test('Escape is handled only while the menu is open, without consuming IME composition',()=>{
 vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()});let tree:ReturnType<typeof create>
 act(()=>{tree=create(<AppDataMenu wrapText={false} save={vi.fn()}/>)});
 const root=()=>tree!.root.findByProps({className:'hx-app-menu'}), trigger=()=>tree!.root.findByProps({'aria-label':'その他のデータビューアー操作'})
 const closed=vi.fn();act(()=>root().props.onKeyDown({key:'Escape',nativeEvent:{isComposing:false},stopPropagation:closed}));expect(closed).not.toHaveBeenCalled()
 act(()=>trigger().props.onClick());const composing=vi.fn();act(()=>root().props.onKeyDown({key:'Escape',nativeEvent:{isComposing:true},stopPropagation:composing}));expect(composing).not.toHaveBeenCalled();expect(tree!.root.findAllByProps({role:'menu'})).toHaveLength(1)
 const handled=vi.fn();act(()=>root().props.onKeyDown({key:'Escape',nativeEvent:{isComposing:false},stopPropagation:handled}));expect(handled).toHaveBeenCalledOnce();expect(tree!.root.findAllByProps({role:'menu'})).toHaveLength(0)
 act(()=>tree!.unmount())
})
test('pending saves cannot close the menu or dispatch duplicate changes and errors remain visible',async()=>{
 vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()});let reject!:(reason:Error)=>void;const save=vi.fn(()=>new Promise<void>((_,r)=>{reject=r}));let tree:ReturnType<typeof create>
 act(()=>{tree=create(<AppDataMenu wrapText={false} save={save}/>)});const trigger=()=>tree!.root.findAllByType('button').find(node=>node.props['aria-label']==='その他のデータビューアー操作')!
 act(()=>trigger().props.onClick());act(()=>{const item=tree!.root.findByProps({role:'menuitemcheckbox'});item.props.onClick();item.props.onClick()});expect(save).toHaveBeenCalledOnce();expect(trigger().props['aria-disabled']).toBe(true)
 act(()=>trigger().props.onClick());expect(tree!.root.findAllByProps({role:'menu'})).toHaveLength(1)
 await act(async()=>{reject(new Error('保存に失敗しました'));await Promise.resolve()});expect(tree!.root.findByProps({role:'alert'}).children).toContain('保存に失敗しました');expect(trigger().props['aria-disabled']).toBe(false)
 act(()=>tree!.unmount())
})
test('focus moves off the disabled menu item during a pending save and returns on failure',async()=>{
 const inside={},doc={activeElement:inside,addEventListener:vi.fn(),removeEventListener:vi.fn()};vi.stubGlobal('document',doc);let reject!:(reason:Error)=>void
 const focusMenu=vi.fn(),focusItem=vi.fn(),focusTrigger=vi.fn(),save=vi.fn(()=>new Promise<void>((_,r)=>{reject=r}));let tree:ReturnType<typeof create>
 act(()=>{tree=create(<AppDataMenu wrapText={false} save={save}/>,{createNodeMock:element=>element.type==='div'&&element.props.className==='hx-app-menu'?{focus:focusMenu,contains:(target:unknown)=>target===inside,querySelector:()=>({focus:focusItem})}:element.type==='button'?{focus:focusTrigger}:null})})
 act(()=>tree!.root.findAllByType('button').find(node=>node.props['aria-label']==='その他のデータビューアー操作')!.props.onClick());expect(focusItem).toHaveBeenCalledOnce()
 act(()=>tree!.root.findByProps({role:'menuitemcheckbox'}).props.onClick());expect(focusMenu).toHaveBeenCalledOnce();expect(focusItem).toHaveBeenCalledOnce()
 await act(async()=>{reject(new Error('保存に失敗しました'));await Promise.resolve()});expect(focusItem).toHaveBeenCalledTimes(2)
 act(()=>tree!.unmount())
})
test.each(['failure','success'])('a %s result does not take back focus moved outside while saving',async outcome=>{
 const inside={},outside={},doc={activeElement:inside,addEventListener:vi.fn(),removeEventListener:vi.fn()};vi.stubGlobal('document',doc)
 let settle!:(failure:boolean)=>void;const focusMenu=vi.fn(),focusItem=vi.fn(),focusTrigger=vi.fn(),save=vi.fn(()=>new Promise<void>((resolve,reject)=>{settle=failure=>failure?reject(new Error('保存失敗')):resolve()}));let tree:ReturnType<typeof create>
 act(()=>{tree=create(<AppDataMenu wrapText={false} save={save}/>,{createNodeMock:element=>element.type==='div'&&element.props.className==='hx-app-menu'?{focus:focusMenu,contains:(target:unknown)=>target===inside,querySelector:()=>({focus:focusItem})}:element.type==='button'?{focus:focusTrigger}:null})})
 act(()=>tree!.root.findAllByType('button').find(node=>node.props['aria-label']==='その他のデータビューアー操作')!.props.onClick());expect(focusItem).toHaveBeenCalledOnce()
 act(()=>tree!.root.findByProps({role:'menuitemcheckbox'}).props.onClick());doc.activeElement=outside
 await act(async()=>{settle(outcome==='failure');await Promise.resolve()});expect(focusItem).toHaveBeenCalledOnce();expect(focusTrigger).not.toHaveBeenCalled()
 if(outcome==='failure')expect(tree!.root.findByProps({role:'alert'}).children).toContain('保存失敗');else expect(tree!.root.findAllByProps({role:'menu'})).toHaveLength(0)
 act(()=>tree!.unmount())
})
test('a successful save returns focus to the trigger when focus remains inside',async()=>{
 const inside={},doc={activeElement:inside,addEventListener:vi.fn(),removeEventListener:vi.fn()};vi.stubGlobal('document',doc);let resolve!:()=>void
 const focusTrigger=vi.fn(),save=vi.fn(()=>new Promise<void>(r=>{resolve=r}));let tree:ReturnType<typeof create>
 act(()=>{tree=create(<AppDataMenu wrapText={false} save={save}/>,{createNodeMock:element=>element.type==='div'&&element.props.className==='hx-app-menu'?{focus:vi.fn(),contains:(target:unknown)=>target===inside,querySelector:()=>({focus:vi.fn()})}:element.type==='button'?{focus:focusTrigger}:null})})
 act(()=>tree!.root.findAllByType('button').find(node=>node.props['aria-label']==='その他のデータビューアー操作')!.props.onClick());act(()=>tree!.root.findByProps({role:'menuitemcheckbox'}).props.onClick())
 await act(async()=>{resolve();await Promise.resolve()});expect(focusTrigger).toHaveBeenCalledOnce();expect(tree!.root.findAllByProps({role:'menu'})).toHaveLength(0)
 act(()=>tree!.unmount())
})
