import { inflateRawSync } from 'node:zlib';
import { skillPackagePath, validateSkillPackage, MAX_SKILL_PACKAGE_BYTES, MAX_SKILL_ASSET_BYTES, MAX_SKILL_PACKAGE_FILES } from './skillPackage.js';

const invalid = () => { throw new Error('Invalid or unsupported skill ZIP.'); };
const crcTable = Uint32Array.from({length:256}, (_,value) => {
  let crc=value;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);return crc>>>0;
});
export function skillFileCrc(bytes) {
  let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;
}

// A deliberately strict ZIP subset: single disk, stored/deflated UTF-8 files.
// No extraction to a filesystem and no executable/symlink interpretation.
export function parseSkillZip(input) {
  try {
    if (!(input instanceof Uint8Array) || input.length<22 || input.length>MAX_SKILL_PACKAGE_BYTES+65536) invalid();
    const view=new DataView(input.buffer,input.byteOffset,input.byteLength);
    const u16=offset=>view.getUint16(offset,true),u32=offset=>view.getUint32(offset,true);
    let end=-1;
    for(let at=input.length-22;at>=Math.max(0,input.length-65557);at--) {
      if(u32(at)===0x06054b50 && at+22+u16(at+20)===input.length){end=at;break;}
    }
    if(end<0 || u16(end+4)!==0 || u16(end+6)!==0 || u16(end+8)!==u16(end+10)) invalid();
    const count=u16(end+10), centralSize=u32(end+12), centralStart=u32(end+16);
    // macOS adds resource-fork sidecars and directory records. These still
    // count toward archive/expansion bounds, but not the 64 actual skill files.
    if(!count || count>MAX_SKILL_PACKAGE_FILES*4 || centralStart+centralSize!==end) invalid();
    const decoder=new TextDecoder('utf-8',{fatal:true});
    const entries=[], ranges=[];let at=centralStart,total=0;
    for(let index=0;index<count;index++) {
      if(at+46>end || u32(at)!==0x02014b50)invalid();
      const flags=u16(at+8),method=u16(at+10),crc=u32(at+16),packed=u32(at+20),size=u32(at+24);
      const nameSize=u16(at+28),extraSize=u16(at+30),commentSize=u16(at+32),start=u32(at+42);
      const mode=u32(at+38)>>>16,type=mode&0xf000;
      if(flags&~(0x800|8|6) || ![0,8].includes(method) || u16(at+34)!==0 || ![0,0x8000,0x4000].includes(type))invalid();
      if(at+46+nameSize+extraSize+commentSize>end || size>MAX_SKILL_ASSET_BYTES)invalid();
      const nameBytes=input.subarray(at+46,at+46+nameSize);
      if(!(flags&0x800)&&nameBytes.some(byte=>byte>=128))invalid();
      const name=decoder.decode(nameBytes),directory=name.endsWith('/');
      if(!skillPackagePath(directory?name.slice(0,-1):name) || type===0x4000&&!directory || type===0x8000&&directory || directory&&size!==0)invalid();
      if(start+30>centralStart || u32(start)!==0x04034b50 || u16(start+6)!==flags || u16(start+8)!==method)invalid();
      const localName=u16(start+26),localExtra=u16(start+28),dataStart=start+30+localName+localExtra,dataEnd=dataStart+packed;
      if(dataEnd>centralStart || localName!==nameSize || decoder.decode(input.subarray(start+30,start+30+localName))!==name)invalid();
      if(!(flags&8)&&(u32(start+14)!==crc||u32(start+18)!==packed||u32(start+22)!==size))invalid();
      if(ranges.some(([a,b])=>start<b&&dataEnd>a))invalid();ranges.push([start,dataEnd]);
      total+=size;if(total>MAX_SKILL_PACKAGE_BYTES)invalid();
      const compressed=input.subarray(dataStart,dataEnd);
      const bytes=method===0?compressed:new Uint8Array(inflateRawSync(compressed,{maxOutputLength:Math.max(1,Math.min(size,MAX_SKILL_ASSET_BYTES))}));
      if(bytes.length!==size || skillFileCrc(bytes)!==crc)invalid();
      // Validate and decompress even Finder metadata before excluding it:
      // an ignored sidecar must not bypass path, link, CRC or size checks.
      // Keep ordinary hidden files and unknown __MACOSX contents.
      const finderMetadata = name.split('/').at(-1)==='.DS_Store'
        || /^__MACOSX\/(?:[^/]+\/)*\._[^/]+$/.test(name);
      if(!directory&&!finderMetadata)entries.push({path:name,bytes});
      at+=46+nameSize+extraSize+commentSize;
    }
    if(at!==end)invalid();
    // Most folder ZIPs contain one enclosing folder. Strip only that common
    // prefix; validate every resulting path through the same package rules.
    if(!entries.some(file=>file.path==='SKILL.md')) {
      const prefix=entries[0]?.path.split('/')[0]+'/';
      if(entries.every(file=>file.path.startsWith(prefix))&&entries.some(file=>file.path===prefix+'SKILL.md')) {
        for(const file of entries)file.path=file.path.slice(prefix.length);
      }
    }
    return validateSkillPackage(entries);
  } catch { return {error:'Invalid, oversized or unsupported skill ZIP.'}; }
}

// Export stored entries: predictable size, no compression work or executables.
export function writeSkillZip(entries) {
  const checked=validateSkillPackage(entries);
  if(checked.error)return checked;
  const locals=[],centrals=[];let offset=0;
  for(const file of entries) {
    const name=new TextEncoder().encode(file.path),bytes=file.bytes,crc=skillFileCrc(bytes);
    const local=new Uint8Array(30+name.length+bytes.length),l=new DataView(local.buffer);
    l.setUint32(0,0x04034b50,true);l.setUint16(4,20,true);l.setUint16(6,0x800,true);
    l.setUint32(14,crc,true);l.setUint32(18,bytes.length,true);l.setUint32(22,bytes.length,true);l.setUint16(26,name.length,true);local.set(name,30);local.set(bytes,30+name.length);
    const central=new Uint8Array(46+name.length),c=new DataView(central.buffer);
    c.setUint32(0,0x02014b50,true);c.setUint16(4,0x314,true);c.setUint16(6,20,true);c.setUint16(8,0x800,true);
    c.setUint32(16,crc,true);c.setUint32(20,bytes.length,true);c.setUint32(24,bytes.length,true);c.setUint16(28,name.length,true);c.setUint32(38,0x80000000,true);c.setUint32(42,offset,true);central.set(name,46);
    locals.push(local);centrals.push(central);offset+=local.length;
  }
  const centralSize=centrals.reduce((n,bytes)=>n+bytes.length,0),end=new Uint8Array(22),e=new DataView(end.buffer);
  e.setUint32(0,0x06054b50,true);e.setUint16(8,entries.length,true);e.setUint16(10,entries.length,true);e.setUint32(12,centralSize,true);e.setUint32(16,offset,true);
  const bytes=new Uint8Array(offset+centralSize+22);let at=0;
  for(const part of [...locals,...centrals,end]){bytes.set(part,at);at+=part.length;}
  return {bytes};
}
