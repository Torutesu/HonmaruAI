import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {AppAnnotationLayer} from './AppAnnotation'

afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals()})

function setup(){
 vi.useFakeTimers()
 const callbacks=new Set<(event:any)=>void>(),postMessage=vi.fn()
 const frameWindow={postMessage}
 const frame={tagName:'IFRAME',closest:()=>null,contentWindow:frameWindow,getBoundingClientRect:()=>({left:0,top:0,width:100,height:100})}
 const host={addEventListener:(_type:string,fn:(event:any)=>void)=>callbacks.add(fn),removeEventListener:(_type:string,fn:(event:any)=>void)=>callbacks.delete(fn)}
 vi.stubGlobal('document',{elementsFromPoint:()=>[frame]});vi.stubGlobal('window',host)
 const element={style:{pointerEvents:'auto'},contains:()=>false,focus:vi.fn(),setPointerCapture:vi.fn(),getBoundingClientRect:()=>({left:0,top:0,width:100,height:100})}
 const onSelect=vi.fn(),onCancel=vi.fn()
 let tree:ReturnType<typeof create>
 act(()=>{tree=create(<AppAnnotationLayer onSelect={onSelect} onCancel={onCancel} onShowAnnotations={()=>{}} showAnnotations={false}/>,{createNodeMock:()=>element})})
 const drag=(x:number)=>{
  const node=tree.root.findByProps({role:'application'})
  act(()=>node.props.onPointerDown({button:0,clientX:x,clientY:10,pointerId:1,preventDefault:vi.fn()}))
  act(()=>node.props.onPointerUp({clientX:x+10,clientY:20,pointerId:1}))
 }
 const respond=(request:any,target:string)=>{for(const cb of [...callbacks])cb({source:frameWindow,data:{type:'honmaru:annotation-target-result',id:request.id,target}})}
 return {tree:tree!,drag,respond,postMessage,callbacks,onSelect,onCancel}
}

test('cancelled annotation cannot reopen from a late iframe response',async()=>{
 const {tree,drag,respond,postMessage,onSelect,onCancel,callbacks}=setup()
 drag(10);const request=postMessage.mock.calls[0][0]
 act(()=>tree.root.findByProps({role:'application'}).props.onKeyDown({key:'Escape',preventDefault:vi.fn()}))
 expect(onCancel).toHaveBeenCalledOnce()
 act(()=>tree.unmount())
 await act(async()=>respond(request,'遅い応答'))
 expect(onSelect).not.toHaveBeenCalled();expect(callbacks.size).toBe(0)
})

test('switching screens during target lookup does not reopen an old selection at timeout',async()=>{
 const {tree,drag,onSelect,callbacks}=setup()
 drag(10);act(()=>tree.update(<div>different section</div>))
 await act(async()=>{vi.advanceTimersByTime(700)})
 expect(onSelect).not.toHaveBeenCalled();expect(callbacks.size).toBe(0)
 act(()=>tree.unmount())
})

test('only the latest selection wins when iframe responses arrive out of order',async()=>{
 const {tree,drag,respond,postMessage,onSelect}=setup()
 drag(10);drag(40)
 const first=postMessage.mock.calls[0][0],second=postMessage.mock.calls[1][0]
 await act(async()=>respond(second,'最新'))
 await act(async()=>respond(first,'古い'))
 expect(onSelect).toHaveBeenCalledTimes(1)
 expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({target:'カスタム画面の最新',x:45}))
 act(()=>tree.unmount())
})

test('current selection resolves normally including timeout fallback',async()=>{
 const {tree,drag,respond,postMessage,onSelect}=setup()
 drag(10);await act(async()=>respond(postMessage.mock.calls[0][0],'ボタン'))
 expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({target:'カスタム画面のボタン'}))
 drag(30);await act(async()=>{vi.advanceTimersByTime(700)})
 expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({target:'画面上の選択範囲'}))
 act(()=>tree.unmount())
})

test('a new pointer down cancels the previous lookup before the next drag completes',async()=>{
 const {tree,drag,respond,postMessage,onSelect,callbacks}=setup()
 drag(10);const first=postMessage.mock.calls[0][0]
 act(()=>tree.root.findByProps({role:'application'}).props.onPointerDown({button:0,clientX:40,clientY:10,pointerId:2,preventDefault:vi.fn()}))
 await act(async()=>respond(first,'古い'))
 expect(onSelect).not.toHaveBeenCalled();expect(callbacks.size).toBe(0)
 act(()=>tree.unmount())
})

test('escape invalidates an immediate non-frame resolution before its microtask',async()=>{
 const {tree,drag,onSelect,onCancel}=setup()
 vi.stubGlobal('document',{elementsFromPoint:()=>[]})
 act(()=>{
  drag(10)
  tree.root.findByProps({role:'application'}).props.onKeyDown({key:'Escape',preventDefault:vi.fn()})
 })
 await act(async()=>{})
 expect(onCancel).toHaveBeenCalledOnce();expect(onSelect).not.toHaveBeenCalled()
 act(()=>tree.unmount())
})

test('ending annotation immediately removes pending frame listeners',async()=>{
 const {tree,drag,callbacks,onSelect,respond,postMessage}=setup()
 drag(10);const request=postMessage.mock.calls[0][0]
 act(()=>tree.root.findByProps({'aria-label':'注釈モードを終了'}).props.onClick())
 expect(callbacks.size).toBe(0)
 await act(async()=>respond(request,'遅い'))
 expect(onSelect).not.toHaveBeenCalled()
 act(()=>tree.unmount())
})

test('postMessage failure falls back without leaving an event listener',async()=>{
 const {tree,drag,postMessage,callbacks,onSelect}=setup()
 postMessage.mockImplementation(()=>{throw Error('frame unavailable')})
 await act(async()=>drag(10))
 expect(callbacks.size).toBe(0)
 expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({target:'画面上の選択範囲'}))
 act(()=>tree.unmount())
})

test('unrelated pointer cancel after pointer up preserves the pending lookup',async()=>{
 const {tree,drag,callbacks,onSelect,respond,postMessage}=setup()
 drag(10);const request=postMessage.mock.calls[0][0]
 act(()=>tree.root.findByProps({role:'application'}).props.onPointerCancel({pointerId:2}))
 expect(callbacks.size).toBe(1)
 await act(async()=>respond(request,'対象'))
 expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({target:'カスタム画面の対象'}))
 act(()=>tree.unmount())
})

test('unrelated pointer up and cancellation do not end the active selection',async()=>{
 const {tree,postMessage,onSelect,respond}=setup();const node=tree.root.findByProps({role:'application'})
 act(()=>node.props.onPointerDown({button:0,clientX:10,clientY:10,pointerId:1,preventDefault:vi.fn()}))
 act(()=>{node.props.onPointerCancel({pointerId:2});node.props.onPointerUp({pointerId:2,clientX:50,clientY:50})})
 expect(postMessage).not.toHaveBeenCalled()
 act(()=>node.props.onPointerUp({pointerId:1,clientX:20,clientY:20}))
 await act(async()=>respond(postMessage.mock.calls[0][0],'対象'))
 expect(onSelect).toHaveBeenCalledTimes(1)
 act(()=>tree.unmount())
})

test('a second pointer cannot steal an in-progress drag',async()=>{
 const {tree,postMessage,onSelect,respond}=setup();const node=tree.root.findByProps({role:'application'})
 act(()=>node.props.onPointerDown({button:0,clientX:10,clientY:10,pointerId:1,preventDefault:vi.fn()}))
 act(()=>{node.props.onPointerDown({button:0,clientX:40,clientY:40,pointerId:2,preventDefault:vi.fn()});node.props.onPointerMove({pointerId:2,clientX:70,clientY:70});node.props.onPointerUp({pointerId:2,clientX:70,clientY:70})})
 expect(postMessage).not.toHaveBeenCalled()
 act(()=>node.props.onPointerUp({pointerId:1,clientX:20,clientY:20}))
 await act(async()=>respond(postMessage.mock.calls[0][0],'対象'))
 expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({x:15,y:15}))
 act(()=>tree.unmount())
})

test('lost pointer capture releases an unfinished drag without cancelling a completed lookup',async()=>{
 const {tree,drag,postMessage,respond,onSelect,callbacks}=setup();const node=tree.root.findByProps({role:'application'})
 act(()=>node.props.onPointerDown({button:0,clientX:10,clientY:10,pointerId:1,preventDefault:vi.fn()}))
 act(()=>node.props.onLostPointerCapture({pointerId:1}))
 drag(40)
 expect(postMessage).toHaveBeenCalledTimes(1)
 act(()=>node.props.onLostPointerCapture({pointerId:1}))
 expect(callbacks.size).toBe(1)
 await act(async()=>respond(postMessage.mock.calls[0][0],'対象'))
 expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({target:'カスタム画面の対象',x:45}))
 act(()=>tree.unmount())
})
