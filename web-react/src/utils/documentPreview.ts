export type DocumentKind='pdf'|'csv'|'text'
export function documentKind(type:string,name:string):DocumentKind|null{
 const mime=type.split(';')[0].trim().toLowerCase()
 if(mime==='application/pdf'||(mime==='application/octet-stream'&&/\.pdf$/i.test(name)))return 'pdf'
 if(mime==='text/csv'||mime==='application/csv'||(/\.csv$/i.test(name)&&['text/plain','application/octet-stream'].includes(mime)))return 'csv'
 if(mime.startsWith('text/')||['application/json','application/xml'].includes(mime))return 'text'
 if(mime==='application/octet-stream'&&/\.(txt|md|json|log|yaml|yml|xml)$/i.test(name))return 'text'
 return null
}
export async function documentBytes(url:string,limit:number,signal:AbortSignal):Promise<Uint8Array>{
 const response=await fetch(url,{signal,credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store'})
 if(!response.ok)throw new Error('ファイルを取得できませんでした。閉じてから再度開いてください。')
 if(Number(response.headers.get('content-length'))>limit){await response.body?.cancel();throw new Error('プレビューできるサイズを超えています。ダウンロードして確認してください。')}
 if(!response.body)throw new Error('ファイルの内容を読み込めませんでした。')
 const reader=response.body.getReader(),chunks:Uint8Array[]=[]
 let size=0
 try{
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength
   if(size>limit)throw new Error('プレビューできるサイズを超えています。ダウンロードして確認してください。')
   chunks.push(value)
  }
 }finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
 const bytes=new Uint8Array(size);let offset=0
 for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
 return bytes
}
export function csvRows(source:string):{rows:string[][];truncated:boolean}{
 const rows:string[][]=[];let row:string[]=[],field='',quoted=false,atStart=true,cells=0
 const cell=()=>{cells++;row.push(field);field='';atStart=true}
 const line=()=>{cell();rows.push(row);row=[]}
 for(let i=0;i<source.length;i++){
  const ch=source[i]
  if(quoted){if(ch==='"'){if(source[i+1]==='"'){field+='"';i++}else quoted=false}else field+=ch;continue}
  if(ch==='"'&&atStart){quoted=true;atStart=false;continue}
  if(ch===','){cell();if(row.length>=100||cells>=20000)return {rows,truncated:true};continue}
  if(ch==='\n'||ch==='\r'){if(ch==='\r'&&source[i+1]==='\n')i++;line();if(rows.length>=5000||cells>=20000)return {rows,truncated:i<source.length-1};continue}
  field+=ch;atStart=false
 }
 if(quoted)throw new Error('CSVの引用符が閉じられていません。テキスト表示かダウンロードで内容を確認してください。')
 if(field||row.length||!atStart)line()
 return {rows,truncated:false}
}
// Keep match offsets in the original string: lowercasing can change its length.
export function documentMatches(text:string,query:string,limit=1000,flexibleWhitespace=false){
 const ranges:Array<{start:number;end:number}>=[]
 if(!query||limit<1)return ranges
 let pattern=query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
 if(flexibleWhitespace)pattern=pattern.replace(/\s+/g,'\\s+')
 const expression=new RegExp(pattern,'giu')
 for(const match of text.matchAll(expression)){
  ranges.push({start:match.index!,end:match.index!+match[0].length})
  if(ranges.length>=limit)break
 }
 return ranges
}

export function pdfTextRuns(items:readonly unknown[]){
 let text=''
 const runs:Array<{text:string;start:number;end:number}>=[]
 for(const item of items){
  if(!item||typeof item!=='object'||!('str'in item)||typeof item.str!=='string')continue
  const start=text.length
  text+=item.str
  runs.push({text:item.str,start,end:text.length})
  text+='hasEOL'in item&&item.hasEOL?'\n':' '
 }
 return {text,runs}
}
