export type FloatingRect = {x:number;y:number;width:number;height:number}
export type FloatingRectStorage = Pick<Storage,'getItem'|'setItem'>

/** Keep local placement separate for each signed-in account, workspace and App. */
export function floatingRectStorageKey(userId:string,orgId:string,appId:string):string|null {
 if(!userId||!orgId||!appId)return null
 return `honmaru:floating-app:v1:${encodeURIComponent(userId)}:${encodeURIComponent(orgId)}:${encodeURIComponent(appId)}`
}

export function readFloatingRect(storage:FloatingRectStorage|undefined,key:string|null,viewport:{width:number;height:number}):FloatingRect|null {
 if(!storage||!key)return null
 try {
  const value=JSON.parse(storage.getItem(key)||'null')
  if(!value||value.version!==1||!value.rect||!['x','y','width','height'].every(name=>Number.isFinite(value.rect[name])))return null
  return fitFloatingRect(value.rect,viewport)
 } catch { return null }
}

export function writeFloatingRect(storage:FloatingRectStorage|undefined,key:string|null,rect:FloatingRect):void {
 if(!storage||!key)return
 try { storage.setItem(key,JSON.stringify({version:1,rect})) } catch { /* Private browsing or full storage: keep this session usable. */ }
}

// Keep every edge and the close control reachable even after display changes.
export function fitFloatingRect(rect:FloatingRect,viewport:{width:number;height:number}):FloatingRect {
 const gap=12, maxWidth=Math.max(1,viewport.width-gap*2),maxHeight=Math.max(1,viewport.height-gap*2)
 const width=Math.min(maxWidth,Math.max(Math.min(360,maxWidth),rect.width))
 const height=Math.min(maxHeight,Math.max(Math.min(300,maxHeight),rect.height))
 return {width,height,x:Math.max(gap,Math.min(rect.x,viewport.width-width-gap)),y:Math.max(gap,Math.min(rect.y,viewport.height-height-gap))}
}
export function initialFloatingRect(width:number,height:number):FloatingRect {
 return fitFloatingRect({x:width-492,y:height-652,width:480,height:640},{width,height})
}
