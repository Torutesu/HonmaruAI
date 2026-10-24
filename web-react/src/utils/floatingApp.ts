export type FloatingRect = {x:number;y:number;width:number;height:number}
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
