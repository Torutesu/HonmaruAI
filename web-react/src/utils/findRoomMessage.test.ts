import {expect,test} from 'vitest'
import {findRoomMessage} from './findRoomMessage'
import type {ChannelMessage} from '../types/card'
const m=(id:number)=>({id:String(id)} as ChannelMessage)
test('loads matches beyond twenty history pages',async()=>{
 const controller=new AbortController();let calls=0
 const result=await findRoomMessage([m(25)],true,'0',controller.signal,async first=>{calls++;const id=Number(first.id)-1;return {messages:[m(id)],more:id>0}})
 expect(calls).toBe(25);expect(result.messages[0].id).toBe('0');expect(result.more).toBe(false)
})
test('cancels a pending history load and rejects nonadvancing cursors',async()=>{
 const controller=new AbortController()
 await expect(findRoomMessage([m(2)],true,'0',controller.signal,async()=>({messages:[m(2)],more:true}))).rejects.toThrow('advance')
 await expect(findRoomMessage([m(2)],true,'0',controller.signal,async()=>{controller.abort();return {messages:[m(0)],more:false}})).rejects.toThrow()
})
