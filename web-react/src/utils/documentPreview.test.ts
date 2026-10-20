import{afterEach,expect,test,vi}from'vitest'
import{csvRows,documentBytes,documentKind}from'./documentPreview'
afterEach(()=>vi.unstubAllGlobals())
test('CSV keeps quoted commas, line breaks, escaped quotes and empty trailing fields',()=>{
 expect(csvRows('name,note,empty\r\n"A, B","first\nsecond ""quoted""",\r\n')).toEqual({rows:[['name','note','empty'],['A, B','first\nsecond "quoted"','']],truncated:false})
 expect(csvRows('""').rows).toEqual([['']]);expect(csvRows('')).toEqual({rows:[],truncated:false})
 expect(()=>csvRows('"broken')).toThrow('引用符')
})
test('CSV reports bounded previews rather than silently dropping large tails',()=>{
 expect(csvRows(Array.from({length:5001},()=> 'one').join('\n')).truncated).toBe(true)
 expect(csvRows(Array.from({length:101},()=> 'one').join(',')).truncated).toBe(true)
 expect(csvRows(Array.from({length:100},()=> 'one').join(',')).truncated).toBe(false)
})
test('document types are a read-only preview, never an executable HTML or SVG player',()=>{
 expect(documentKind('application/pdf','x')).toBe('pdf')
 expect(documentKind('application/octet-stream','x.csv')).toBe('csv')
 expect(documentKind('text/html','x.html')).toBe('text')
 expect(documentKind('image/svg+xml','x.svg')).toBeNull()
 expect(documentKind('application/octet-stream','x.exe')).toBeNull()
})
test('streaming download limit is enforced even without a Content-Length',async()=>{
 let cancelled=false
 const body=new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array(6))},cancel(){cancelled=true}})
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(body)))
 await expect(documentBytes('https://files.example/one',5,new AbortController().signal)).rejects.toThrow('サイズ')
 expect(cancelled).toBe(true)
})
test('preview fetch omits credentials and preserves bytes within the limit',async()=>{
 const fetch=vi.fn().mockResolvedValue(new Response(new Uint8Array([1,2,3])))
 vi.stubGlobal('fetch',fetch)
 expect(await documentBytes('https://files.example/one',5,new AbortController().signal)).toEqual(new Uint8Array([1,2,3]))
 expect(fetch.mock.calls[0][1]).toMatchObject({credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store'})
})
