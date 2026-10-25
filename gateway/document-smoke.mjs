// Synthetic-only renderer smoke test. No user files or credentials enter the VM.
import {writeFile,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runDocumentIsolated} from './document-runner.mjs';
const image=process.argv[2];if(!image)throw Error('Pass the pinned document image to verify.');
const directory=await mkdtemp(join(tmpdir(),'honmaru-document-smoke-'));
console.log('Artifacts:',directory);
const sources={
 markdown:'# Honmaru 変換確認\n\n日本語の本文と **太字**。\n\n| 項目 | 金額 |\n|---|---|\n| コーヒー | 540円 |\n\n[参照リンク](https://example.com)\n',
 html:'<!doctype html><html><head><meta charset="utf-8"></head><body><h1>Honmaru 変換確認</h1><p>日本語の本文と <strong>太字</strong>。</p><table border="1"><tr><th>項目</th><th>金額</th></tr><tr><td>コーヒー</td><td>540円</td></tr></table><p><a href="https://example.com">参照リンク</a></p></body></html>',
};
for(const [inputFormat,text] of Object.entries(sources))for(const format of ['docx','pdf']){
 const result=await runDocumentIsolated({text,inputFormat,format},{image});
 await writeFile(join(directory,`${inputFormat}.${format}`),result.bytes);
 console.log(inputFormat,format,result.size,result.sha256);
}
