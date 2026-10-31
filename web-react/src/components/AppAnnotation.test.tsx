import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test,vi} from 'vitest'
import {annotationTargetAt,AppAnnotationDialog,resolveCustomAppAnnotationTarget} from './AppAnnotation'
import {AppConversationPanel} from './AppConversationPanel'

test('annotation target lookup temporarily exposes the app beneath the drag layer',()=>{
 const target={tagName:'DIV',closest:()=>null,getAttribute:()=>null} as unknown as Element
 const layer={style:{pointerEvents:'auto'},contains:()=>false} as unknown as HTMLElement
 const root={elementsFromPoint:()=>{expect(layer.style.pointerEvents).toBe('none');return [target]}}
 expect(annotationTargetAt(20,30,layer,root)).toBe('画面上の選択範囲')
 expect(layer.style.pointerEvents).toBe('auto')
})

test('annotation resolves an element inside a sandboxed custom app and rejects other frame messages',async()=>{
 const postMessage=vi.fn(),callbacks=new Map<string,(event:any)=>void>()
 const contentWindow={postMessage}
 const frame={tagName:'IFRAME',contentWindow,getBoundingClientRect:()=>({left:10,top:20,width:100,height:50})} as unknown as HTMLIFrameElement
 const root={elementsFromPoint:()=>[frame]} as unknown as Document
 const host={addEventListener:(type:string,callback:(event:any)=>void)=>callbacks.set(type,callback),removeEventListener:(type:string)=>callbacks.delete(type)} as unknown as Window
 const pending=resolveCustomAppAnnotationTarget(40,60,'画面上の選択範囲',root,host)
 const request=postMessage.mock.calls[0][0]
 expect(request).toMatchObject({type:'honmaru:annotation-target-request',x:30,y:40})
 const receive=callbacks.get('message')!
 receive({source:{},data:{type:'honmaru:annotation-target-result',id:request.id,target:'偽のフレーム'}})
 receive({source:contentWindow,data:{type:'honmaru:annotation-target-result',id:request.id,target:'ボタン\n操作'}})
 await expect(pending).resolves.toBe('カスタム画面のボタン 操作')
 expect(callbacks.has('message')).toBe(false)
})

test('annotation falls back when the custom frame is unavailable',async()=>{
 const frame={tagName:'IFRAME',contentWindow:null} as unknown as HTMLIFrameElement
 await expect(resolveCustomAppAnnotationTarget(5,5,'画面上の選択範囲',{elementsFromPoint:()=>[frame]} as unknown as Document)).resolves.toBe('画面上の選択範囲')
})

test('annotation dialog requires a comment and submits trimmed text',async()=>{
 const onSubmit=vi.fn(),onCancel=vi.fn();let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<AppAnnotationDialog selection={{target:'列「Task」',x:30,y:50}} appName="Tasks" section="データビューアー" onCancel={onCancel} onSubmit={onSubmit}/>)});
 const submit=()=>tree!.root.findByType('form').props.onSubmit({preventDefault:vi.fn()})
 await act(async()=>submit());expect(onSubmit).not.toHaveBeenCalled()
 act(()=>tree!.root.findByType('textarea').props.onChange({target:{value:'  Change this column  '}}))
 await act(async()=>submit());expect(onSubmit).toHaveBeenCalledWith('Change this column');expect(onCancel).not.toHaveBeenCalled()
 act(()=>tree!.unmount())
})

test('annotation becomes an editable app-chat draft after persisted draft restoration',async()=>{
 vi.stubGlobal('document',{visibilityState:'visible'})
 const writes:string[]=[],consumed=vi.fn(),api:any={
  conversation:vi.fn().mockResolvedValue({messages:[],hasMore:false}),
  postConversation:vi.fn(),
  drafts:{read:()=> 'Existing draft',write:(value:string)=>writes.push(value)},
 }
 let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<AppConversationPanel api={api} appId="app" title="Tasks" annotationDraft={{id:'annotation-1',text:'Annotation: update the status field'}} onAnnotationDraftConsumed={consumed}/>)});
 expect(tree!.root.findByType('textarea').props.value).toBe('Existing draft\n\nAnnotation: update the status field')
 expect(writes.at(-1)).toBe('Existing draft\n\nAnnotation: update the status field')
 expect(consumed).toHaveBeenCalledWith('annotation-1');expect(api.postConversation).not.toHaveBeenCalled()
 act(()=>tree!.unmount());vi.unstubAllGlobals()
})
