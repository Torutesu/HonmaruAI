import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,access} from 'node:fs/promises';
import {join} from 'node:path';
import {convertDocument} from '../document-converter.mjs';

test('converter returns binary bytes beyond the execution stdout cap and removes scratch files',async()=>{
 let directory;const bytes=Buffer.concat([Buffer.from('PK\x03\x04'),Buffer.alloc(40000,7)]);
 const result=await convertDocument({text:'# 日本語',inputFormat:'markdown',format:'docx'},{run:async(_binary,_args,options)=>{directory=options.cwd;await writeFile(join(directory,'source.docx'),bytes)}});
 assert.deepEqual(result.bytes,bytes);assert.equal(result.size,bytes.length);assert.equal(result.sha256.length,64);
 await assert.rejects(access(directory));
});
test('a converter success without a valid document is rejected and cleaned up',async()=>{
 let directory;
 await assert.rejects(convertDocument({text:'<p>hello</p>',inputFormat:'html',format:'pdf'},{run:async(_binary,_args,options)=>{directory=options.cwd;await writeFile(join(directory,'source.pdf'),'not a PDF')}}),/invalid format/);
 await assert.rejects(access(directory));
});
test('failed and cancelled conversions never return an artifact and clean scratch data',async()=>{
 let directory;
 await assert.rejects(convertDocument({text:'secret',inputFormat:'markdown',format:'docx'},{run:async(_b,_a,options)=>{directory=options.cwd;throw Error('conversion failed')}}),/conversion failed/);
 await assert.rejects(access(directory));
 const controller=new AbortController();controller.abort();
 await assert.rejects(convertDocument({text:'hello',inputFormat:'html',format:'pdf'},{signal:controller.signal}));
});
test('unsupported formats and oversized inputs cannot launch a process',async()=>{
 for(const input of [{text:'x',inputFormat:'html',format:'exe'},{text:'x',inputFormat:'shell',format:'pdf'},{text:'x'.repeat(2*1024*1024+1),inputFormat:'markdown',format:'pdf'}])await assert.rejects(convertDocument(input,{run:()=>{assert.fail('must not run')}}),/Invalid document conversion input/);
});
