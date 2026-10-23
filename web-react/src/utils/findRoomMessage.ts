import type {ChannelMessage} from '../types/card'

// Follow history cursors until the selected result is loaded. Repeated or
// empty cursors fail instead of looping forever; cancellation leaves the UI alone.
export async function findRoomMessage(initial:ChannelMessage[], more:boolean, id:string, signal:AbortSignal, page:(first:ChannelMessage)=>Promise<{messages:ChannelMessage[];more:boolean}>){
 let messages=initial
 while(!messages.some(message=>message.id===id)&&more&&messages.length){
  signal.throwIfAborted()
  const result=await page(messages[0]);signal.throwIfAborted()
  const known=new Set(messages.map(message=>message.id)),older=result.messages.filter(message=>!known.has(message.id))
  if(!older.length&&result.more)throw new Error('History cursor did not advance')
  messages=[...older,...messages];more=result.more
 }
 signal.throwIfAborted()
 if(!messages.some(message=>message.id===id))throw new Error('Message is no longer available')
 return {messages,more}
}
