import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test,vi} from 'vitest'
import {annotationTargetAt,AppAnnotationDialog,AppAnnotationList,AppAnnotationMarkers,resolveCustomAppAnnotationTarget} from './AppAnnotation'
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

test('persisted app annotations render at their saved point and show the message on click',()=>{
 const annotation:any={id:'a1',tableId:'',rowId:'',messageSource:'app',messageId:'3',target:'Status field',x:44,y:66,section:'data',authorId:'1',authorName:'Alice',body:'Please review\n\n注釈: Tasks · データビューアー · Status field\nTighten the spacing',createdAt:'2026-10-31T00:00:00.000Z'}
 let tree:ReturnType<typeof create>,openId:string|null=null;const onOpenChange=vi.fn((id:string|null)=>{openId=id})
 const render=()=> <AppAnnotationMarkers annotations={[annotation]} section="data" openId={openId} onOpenChange={onOpenChange}/>
 act(()=>{tree=create(render())});
 const pin=tree!.root.findByProps({className:'hx-annotation-pin'});expect(pin.props['aria-label']).toContain('Status field')
 expect(tree!.root.findByProps({className:'hx-annotation-marker'}).props.style).toEqual({left:'44%',top:'66%'})
 act(()=>pin.props.onClick());act(()=>tree!.update(render()));expect(tree!.root.findByProps({className:'hx-annotation-card'}).findByType('p').children.join('')).toBe('Please review\nTighten the spacing')
 act(()=>tree!.unmount())
})

test('annotation list matches Kylon empty and populated states and opens the chosen marker',()=>{
 const annotation:any={id:'a1',tableId:'',rowId:'',messageSource:'app',messageId:'3',target:'Status field',x:44,y:66,section:'data',authorId:'1',authorName:'Alice',body:'Please review\n\n注釈: Tasks · データビューアー · Status field\nTighten the spacing',createdAt:'2026-10-31T00:00:00.000Z'}
 const onClose=vi.fn(),onSelect=vi.fn();let tree:ReturnType<typeof create>
 act(()=>{tree=create(<AppAnnotationList annotations={[]} onClose={onClose} onSelect={onSelect}/>)});
 expect(tree!.root.findByProps({className:'hx-annotation-list'}).props['aria-label']).toBe('注釈0件')
 expect(tree!.root.findByProps({className:'hx-annotation-list-empty'}).children.join('')).toContain('まだ注釈がありません')
 act(()=>tree!.update(<AppAnnotationList annotations={[annotation]} onClose={onClose} onSelect={onSelect}/>))
 const item=tree!.root.findByProps({className:'hx-annotation-list-item'});act(()=>item.props.onClick());expect(onSelect).toHaveBeenCalledWith(annotation)
 act(()=>tree!.unmount())
})

test('annotation dialog requires a comment and submits trimmed text',async()=>{
 const onSubmit=vi.fn(),onCancel=vi.fn();let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<AppAnnotationDialog selection={{target:'Task name',x:30,y:50,rect:{left:22,top:44,width:18,height:5}}} appName="Tasks" section="データビューアー" context="Tasks · All records" onCancel={onCancel} onSubmit={onSubmit}/>)});
 expect(tree!.root.findByProps({role:'dialog'}).props['aria-modal']).toBe('false')
 expect(tree!.root.findByProps({className:'hx-annotation-highlight'}).props.style).toEqual({left:'22%',top:'44%',width:'18%',height:'5%'})
 expect(tree!.root.findByProps({className:'hx-annotation-context'}).children.join('')).toBe('Tasks · All records · Task name')
 expect(tree!.root.findByType('textarea').props.placeholder).toBe('どのように修正しますか？')
 const submit=()=>tree!.root.findByType('form').props.onSubmit({preventDefault:vi.fn()})
 await act(async()=>submit());expect(onSubmit).not.toHaveBeenCalled()
 act(()=>tree!.root.findByType('textarea').props.onChange({target:{value:'  Change this column  '}}))
 await act(async()=>submit());expect(onSubmit).toHaveBeenCalledWith('Change this column');expect(onCancel).not.toHaveBeenCalled()
 act(()=>tree!.unmount())
})

test('annotation becomes an editable app-chat draft after persisted draft restoration',async()=>{
 vi.stubGlobal('document',{visibilityState:'visible'})
 const writes:string[]=[],consumed=vi.fn(),writeAnnotation=vi.fn(),marker={target:'Task status',x:44,y:66,section:'data' as const},api:any={
  conversation:vi.fn().mockResolvedValue({messages:[],hasMore:false}),
  postConversation:vi.fn(),
  drafts:{read:()=> 'Existing draft',write:(value:string)=>writes.push(value),writeAnnotation},
 }
 let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<AppConversationPanel api={api} appId="app" title="Tasks" annotationDraft={{id:'annotation-1',text:'Annotation: update the status field',marker}} onAnnotationDraftConsumed={consumed}/>)});
 expect(tree!.root.findByType('textarea').props.value).toBe('Existing draft\n\nAnnotation: update the status field')
 expect(writes.at(-1)).toBe('Existing draft\n\nAnnotation: update the status field')
 expect(writeAnnotation).toHaveBeenCalledWith(marker,'app',undefined,undefined)
 expect(consumed).toHaveBeenCalledWith('annotation-1');expect(api.postConversation).not.toHaveBeenCalled()
 act(()=>tree!.unmount());vi.unstubAllGlobals()
})

test('restored app annotation metadata is sent only with the explicit chat submission',async()=>{
 vi.stubGlobal('document',{visibilityState:'visible'})
 const marker={target:'Task status',x:44,y:66,section:'data' as const},postConversation=vi.fn().mockResolvedValue({}),api:any={
  conversation:vi.fn().mockResolvedValue({messages:[],hasMore:false,annotations:[]}),postConversation,
  drafts:{read:()=> 'Please change the status',readAnnotation:()=>marker,write:vi.fn(),writeAnnotation:vi.fn()},
 }
 let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<AppConversationPanel api={api} appId="app" title="Tasks"/>)});
 expect(postConversation).not.toHaveBeenCalled()
 await act(async()=>tree!.root.findByType('form').props.onSubmit({preventDefault:vi.fn()}))
 expect(postConversation).toHaveBeenCalledWith('app',{tableId:undefined,rowId:undefined},'Please change the status',expect.any(String),marker)
 act(()=>tree!.unmount());vi.unstubAllGlobals()
})
