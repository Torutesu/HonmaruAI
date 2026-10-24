import React from 'react'
import {act, create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {AgentRunStop} from './AgentRunStop'
vi.mock('../utils/i18n',()=>({useT:()=> (text:string)=>text}))
const props={api:{httpBase:'https://api.example',orgId:'org',sessionToken:'session'},channel:'b:room',rowId:'source',assignmentId:'assignment',generation:2,onStopped:vi.fn()}
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks()})
test('stop sends the observed generation once and confirms only the server acknowledgement',async()=>{
 let resolve!:(value:unknown)=>void;const fetch=vi.fn().mockImplementation(()=>new Promise(r=>{resolve=r}));vi.stubGlobal('fetch',fetch)
 let tree!:ReturnType<typeof create>;await act(async()=>{tree=create(<AgentRunStop {...props}/>)});
 await act(async()=>{tree.root.findByType('button').props.onClick();tree.root.findByType('button').props.onClick()});
 expect(fetch).toHaveBeenCalledTimes(1);expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({generation:2,assignmentId:'assignment',messageId:'source'});
 expect(JSON.stringify(tree.toJSON())).toContain('Stopping agent execution');expect(props.onStopped).not.toHaveBeenCalled();
 await act(async()=>{resolve({ok:true,status:200,json:async()=>({stopped:true})})});
 expect(props.onStopped).toHaveBeenCalledTimes(1);expect(tree.root.findByType('button').props.disabled).toBe(true);
 act(()=>tree.unmount());
});
test('generation conflict refreshes state without claiming a successful stop',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false,status:409}));let tree!:ReturnType<typeof create>;
 await act(async()=>{tree=create(<AgentRunStop {...props}/>)});
 await act(async()=>tree.root.findByType('button').props.onClick());
 expect(JSON.stringify(tree.toJSON())).toContain('Execution changed');expect(JSON.stringify(tree.toJSON())).not.toContain('Agent execution cancelled');expect(props.onStopped).toHaveBeenCalledTimes(1);
 act(()=>tree.unmount());
});
test('a lost response is unconfirmed and unmount aborts the old request',async()=>{
 const fetch=vi.fn().mockRejectedValue(new Error('lost'));vi.stubGlobal('fetch',fetch);let tree!:ReturnType<typeof create>;
 await act(async()=>{tree=create(<AgentRunStop {...props}/>)});await act(async()=>tree.root.findByType('button').props.onClick());
 expect(JSON.stringify(tree.toJSON())).toContain('Could not confirm');expect(props.onStopped).not.toHaveBeenCalled();
 fetch.mockImplementation(()=>new Promise(()=>{}));await act(async()=>tree.root.findByType('button').props.onClick());
 const signal=fetch.mock.calls[1][1].signal;act(()=>tree.unmount());expect(signal.aborted).toBe(true);
});
