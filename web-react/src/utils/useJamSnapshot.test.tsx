import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test} from 'vitest'
import {useJamSnapshot} from './useJamSnapshot'
import type {JamState} from './jam'
const state={channel:'b:kitchen',active:true,participants:[],mode:'off'} as unknown as JamState

test('initial Jam state survives a delayed conversation mount; ended calls and resets disappear',()=>{
 let socket:ReturnType<typeof useJamSnapshot>,display:Record<string,JamState>|undefined
 function Conversation({states}:{states:Record<string,JamState>}){display=states;return null}
 function Parent({visible=false,scope='first'}:{visible?:boolean;scope?:string}){socket=useJamSnapshot(scope);return visible?<Conversation states={socket.states}/>:null}
 let tree:ReturnType<typeof create>
 act(()=>{tree=create(<Parent/>)})
 act(()=>socket.receive('jam_state',state))
 expect(display).toBeUndefined()
 act(()=>tree.update(<Parent visible/>))
 expect(display?.['b:kitchen']).toBe(state)
 act(()=>socket.receive('jam_offer',{channel:'b:other',active:true}))
 expect(Object.keys(display!)).toEqual(['b:kitchen'])
 act(()=>socket.receive('jam_state',{...state,active:false}))
 expect(display).toEqual({})
 act(()=>socket.receive('jam_state',state));act(()=>socket.reset())
 expect(display).toEqual({})
 act(()=>socket.receive('jam_state',state));act(()=>tree.update(<Parent visible scope="another-session"/>))
 expect(display).toEqual({})
 act(()=>tree.unmount())
})
