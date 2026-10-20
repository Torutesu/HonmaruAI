import { expect,test } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { parseSkillZip,skillFileCrc } from '../src/harness/skillZip.js';
const encoder=new TextEncoder();
const markdown='---\nname: report\ndescription: Write reports\n---\nRead templates/report.md.';
function zip(files,method=8) {
 const locals=[],centrals=[];let offset=0;
 for(const file of files) {
  const name=encoder.encode(file.path),bytes=typeof file.body==='string'?encoder.encode(file.body):file.body;
  const packed=method===8?new Uint8Array(deflateRawSync(bytes)):bytes,crc=skillFileCrc(bytes),size=file.declared??bytes.length;
  const local=new Uint8Array(30+name.length+packed.length),l=new DataView(local.buffer);
  l.setUint32(0,0x04034b50,true);l.setUint16(4,20,true);l.setUint16(6,0x800,true);l.setUint16(8,method,true);l.setUint32(14,crc,true);l.setUint32(18,packed.length,true);l.setUint32(22,size,true);l.setUint16(26,name.length,true);local.set(name,30);local.set(packed,30+name.length);
  const central=new Uint8Array(46+name.length),c=new DataView(central.buffer);
  c.setUint32(0,0x02014b50,true);c.setUint16(4,0x314,true);c.setUint16(6,20,true);c.setUint16(8,0x800,true);c.setUint16(10,method,true);c.setUint32(16,crc,true);c.setUint32(20,packed.length,true);c.setUint32(24,size,true);c.setUint16(28,name.length,true);c.setUint32(38,(file.mode??0x8000)<<16,true);c.setUint32(42,offset,true);central.set(name,46);
  locals.push(local);centrals.push(central);offset+=local.length;
 }
 const centralSize=centrals.reduce((n,b)=>n+b.length,0),end=new Uint8Array(22),e=new DataView(end.buffer);
 e.setUint32(0,0x06054b50,true);e.setUint16(8,files.length,true);e.setUint16(10,files.length,true);e.setUint32(12,centralSize,true);e.setUint32(16,offset,true);
 const out=new Uint8Array(offset+centralSize+22);let at=0;for(const bytes of [...locals,...centrals,end]){out.set(bytes,at);at+=bytes.length}return out;
}
test.each([0,8])('imports method %s ZIP with a folder wrapper and binary assets',method=>{
 const result=parseSkillZip(zip([{path:'reports/SKILL.md',body:markdown},{path:'reports/templates/report.md',body:'Template'},{path:'reports/image.png',body:new Uint8Array([0,255,128])}],method));
 expect(result.draft?.name).toBe('report');expect(result.files?.map(f=>f.path)).toEqual(['templates/report.md','image.png']);expect(result.files?.[1].bytes).toEqual(new Uint8Array([0,255,128]));
});
test('rejects traversal even when it looks like a common enclosing folder',()=>{
 expect(parseSkillZip(zip([{path:'../SKILL.md',body:markdown}])).error).toBeTruthy();
});
test('rejects links, lying expansion sizes, corruption and truncated directories',()=>{
 const root={path:'SKILL.md',body:markdown};
 expect(parseSkillZip(zip([root,{path:'link',body:'target',mode:0xa000}])).error).toBeTruthy();
 expect(parseSkillZip(zip([root,{path:'bomb',body:'x'.repeat(2000000),declared:1}])).error).toBeTruthy();
 const corrupt=zip([root],0);corrupt[40]^=1;expect(parseSkillZip(corrupt).error).toBeTruthy();
 expect(parseSkillZip(zip([root]).subarray(0,-1)).error).toBeTruthy();
});
