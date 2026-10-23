import {readImage} from '../userAvatar.js';
// Content-Type alone must not turn an arbitrary upload into a room image.
export async function readRoomVisualImage(request) {
 const image=await readImage(request);
 if(image.error)return image;
 const b=image.bytes,starts=xs=>xs.every((x,i)=>b[i]===x);
 const ascii=(start,end)=>String.fromCharCode(...b.slice(start,end));
 const matches=image.contentType==='image/png'?starts([137,80,78,71,13,10,26,10])
  :image.contentType==='image/jpeg'?starts([255,216,255])
  :image.contentType==='image/gif'?['GIF87a','GIF89a'].includes(ascii(0,6))
  :b.length>=12&&ascii(0,4)==='RIFF'&&ascii(8,12)==='WEBP';
 return matches?image:{error:'The image contents do not match its file type.',status:415};
}
