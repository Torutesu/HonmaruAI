import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {RoomWebhooks} from './RoomWebhooks'
vi.mock('../utils/i18n',()=>({useT:()=> (s:string)=>s}))
const api={httpBase:'https://relay.test',orgId:'org',sessionToken:'token'}
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers()})
test('creation reveals the returned key only until dismissed',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({hooks:[]})}).mockResolvedValueOnce({ok:true,json:async()=>({hook:{id:'hook',name:'Deploy',version:1},secret:'secret'})})
 vi.stubGlobal('fetch',fetcher);let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<RoomWebhooks api={api} channel="b:room"/>)})
 act(()=>tree.root.findByType('input').props.onChange({target:{value:'Deploy'}}))
 await act(async()=>tree.root.findByType('form').props.onSubmit({preventDefault:vi.fn()}))
 expect(tree.root.findAllByType('input').some(i=>i.props.value==='Bearer secret')).toBe(true)
 act(()=>tree.root.findAllByType('button').find(b=>b.props.children==="Hide secret")!.props.onClick())
 expect(tree.root.findAllByType('input').some(i=>i.props.value==='Bearer secret')).toBe(false)
 act(()=>tree.unmount())
})
test('unconfirmed writes prevent another creation until the list is read back',async()=>{
 vi.useFakeTimers();const fetcher=vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({hooks:[]})}).mockImplementationOnce(()=>new Promise(()=>{}))
 vi.stubGlobal('fetch',fetcher);let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<RoomWebhooks api={api} channel="b:room"/>)})
 act(()=>tree.root.findByType('input').props.onChange({target:{value:'Deploy'}}))
 act(()=>tree.root.findByType('form').props.onSubmit({preventDefault:vi.fn()}))
 await act(async()=>{await vi.advanceTimersByTimeAsync(15000)})
 expect(tree.root.findAllByType('button').find(b=>b.props.children==="Create webhook")!.props.disabled).toBe(true)
 expect(fetcher.mock.calls[1][1].signal.aborted).toBe(true)
 act(()=>tree.unmount())
})

test('switching rooms aborts the old request and never reveals its late secret',async()=>{
 let resolveOld!:(value:any)=>void
 const fetcher=vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({hooks:[]})})
  .mockImplementationOnce(()=>new Promise(resolve=>{resolveOld=resolve}))
  .mockResolvedValueOnce({ok:true,json:async()=>({hooks:[]})})
 vi.stubGlobal('fetch',fetcher);let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<RoomWebhooks api={api} channel="b:first"/>)})
 act(()=>tree.root.findByType('input').props.onChange({target:{value:'First room'}}))
 act(()=>tree.root.findByType('form').props.onSubmit({preventDefault:vi.fn()}))
 await act(async()=>tree.update(<RoomWebhooks api={api} channel="b:second"/>))
 expect(fetcher.mock.calls[1][1].signal.aborted).toBe(true)
 await act(async()=>resolveOld({ok:true,json:async()=>({hook:{id:'old',name:'First room',version:1},secret:'old-secret'})}))
 expect(tree.root.findByType('input').props.value).toBe('')
 expect(JSON.stringify(tree.toJSON())).not.toContain('old-secret')
 expect(JSON.stringify(tree.toJSON())).not.toContain('First room')
 act(()=>tree.unmount())
})


test('a failed initial list is not presented as empty and reload restores creation',async()=>{
 const fetcher=vi.fn().mockRejectedValueOnce(Error('Network unavailable'))
  .mockResolvedValueOnce({ok:true,json:async()=>({hooks:[]})})
 vi.stubGlobal('fetch',fetcher);let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<RoomWebhooks api={api} channel="b:room"/>)})
 expect(JSON.stringify(tree.toJSON())).not.toContain('No webhooks yet.')
 expect(tree.root.findByProps({role:'alert'}).children.join('')).toContain('Network unavailable')
 act(()=>tree.root.findByType('input').props.onChange({target:{value:'Deploy'}}))
 expect(tree.root.findAllByType('button').find(b=>b.props.children==='Create webhook')!.props.disabled).toBe(true)
 await act(async()=>tree.root.findAllByType('button').find(b=>b.props.children==='Reload list')!.props.onClick())
 expect(JSON.stringify(tree.toJSON())).toContain('No webhooks yet.')
 expect(tree.root.findAllByType('button').find(b=>b.props.children==='Create webhook')!.props.disabled).toBe(false)
 act(()=>tree.unmount())
})

test('recent events distinguish queued work from an unavailable result',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({hooks:[{id:'hook',name:'Deploy',version:1,revokedAt:null}],events:[{messageId:'one',hookId:'hook',createdAt:'2026-10-23T00:00:00Z',status:'queued'},{messageId:'two',hookId:'hook',createdAt:'2026-10-23T00:01:00Z',status:'unknown'}]})}));
 let tree!:ReturnType<typeof create>;
 await act(async()=>{tree=create(<RoomWebhooks api={api} channel="b:room"/>)});
 const text=JSON.stringify(tree.toJSON());
 expect(text).toContain('Queued');expect(text).toContain('Status unavailable');expect(text).not.toContain('Reply saved');
 act(()=>tree.unmount());
});

test('interrupted retry requires a second action and sends the observed version',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({hooks:[],events:[{messageId:'event',hookId:'hook',createdAt:'2026-10-23T00:00:00Z',status:'interrupted',canRetry:true,version:123}]})}).mockResolvedValueOnce({ok:true,json:async()=>({queued:true,messageId:'event'})});
 vi.stubGlobal('fetch',fetcher);let tree!:ReturnType<typeof create>;
 await act(async()=>{tree=create(<RoomWebhooks api={api} channel="b:room"/>)});
 act(()=>tree.root.findAllByType('button').find(b=>b.props.children==='Retry execution')!.props.onClick());
 expect(fetcher).toHaveBeenCalledTimes(1);
 await act(async()=>tree.root.findAllByType('button').find(b=>b.props.children==='Retry this interrupted execution')!.props.onClick());
 expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({action:'retry',messageId:'event',version:123,confirmInterrupted:true});
 expect(JSON.stringify(tree.toJSON())).toContain('Queued');
 expect(tree.root.findAllByType('button').some(b=>b.props.children==='Retry execution')).toBe(false);
 act(()=>tree.unmount());
});

test('an event links to its own conversation in the correct workspace and dismisses settings',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({hooks:[],events:[{messageId:'event-root',hookId:'hook',createdAt:'2026-10-23T00:00:00Z',status:'interrupted'}]})}));
 let tree!:ReturnType<typeof create>;const close=vi.fn();
 await act(async()=>{tree=create(<RoomWebhooks api={{...api,orgId:'team:workspace'}} channel="b:room" onOpenThread={close}/>)});
 const link=tree.root.findByType('a');
 expect(link.props.href).toBe('#/t/event-root/team%3Aworkspace');
 act(()=>link.props.onClick({preventDefault:vi.fn()}));expect(close).toHaveBeenCalledTimes(1);
 act(()=>tree.unmount());
});

test.each([true,false])('credential copying reports the clipboard outcome (success=%s)',async success=>{
 const writeText=vi.fn().mockImplementation(async()=>{if(!success)throw Error('denied')});
 vi.stubGlobal('navigator',{clipboard:{writeText}});
 vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({hooks:[]})}).mockResolvedValueOnce({ok:true,json:async()=>({hook:{id:'hook',name:'Deploy',version:1},secret:'test-secret'})}));
 let tree!:ReturnType<typeof create>;
 await act(async()=>{tree=create(<RoomWebhooks api={api} channel="b:room"/>)});
 act(()=>tree.root.findByType('input').props.onChange({target:{value:'Deploy'}}));
 await act(async()=>tree.root.findByType('form').props.onSubmit({preventDefault:vi.fn()}));
 await act(async()=>tree.root.findAllByType('button').find(b=>Array.isArray(b.props.children)&&b.props.children.includes('Copy authorization header'))!.props.onClick());
 expect(writeText).toHaveBeenCalledWith('Bearer test-secret');
 const text=JSON.stringify(tree.toJSON());
 expect(text).toContain(success?'Copied':'Could not copy. Select and copy the value manually.');
 if(!success)expect(text).not.toContain('Copied');
 act(()=>tree.root.findAllByType('button').find(b=>b.props.children==='Hide secret')!.props.onClick());
 expect(JSON.stringify(tree.toJSON())).not.toContain('test-secret');
 act(()=>tree.unmount());
});


test('keyboard creation ignores conversion Enter and submits a trimmed name once',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({hooks:[]})}).mockImplementationOnce(()=>new Promise(()=>{}));
 vi.stubGlobal('fetch',fetcher);let tree!:ReturnType<typeof create>;
 await act(async()=>{tree=create(<RoomWebhooks api={api} channel="b:room"/>)});
 act(()=>tree.root.findByType('input').props.onChange({target:{value:'  デプロイ通知  '}}));
 for(const nativeEvent of [{isComposing:true},{keyCode:229}]){
  const preventDefault=vi.fn();
  act(()=>tree.root.findByType('input').props.onKeyDown({key:'Enter',nativeEvent,preventDefault}));
  expect(preventDefault).toHaveBeenCalledOnce();
 }
 expect(fetcher).toHaveBeenCalledTimes(1);
 const normalEnter=vi.fn();
 act(()=>tree.root.findByType('input').props.onKeyDown({key:'Enter',nativeEvent:{},preventDefault:normalEnter}));
 expect(normalEnter).not.toHaveBeenCalled();
 const submit=tree.root.findByType('form').props.onSubmit;
 act(()=>{submit({preventDefault:vi.fn()});submit({preventDefault:vi.fn()})});
 expect(fetcher).toHaveBeenCalledTimes(2);
 expect(JSON.parse(fetcher.mock.calls[1][1].body).name).toBe('デプロイ通知');
 act(()=>tree.unmount());
});
