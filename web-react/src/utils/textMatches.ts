// Indices refer to the original UTF-16 text, as DOM Range requires. Lowercasing
// a string first can change its length (for example U+0130) and corrupt offsets.
export function textMatchRanges(text:string,query:string):Array<[number,number]> {
 const needle=query.trim()
 if(!needle)return []
 const pattern=new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'giu')
 return [...text.matchAll(pattern)].map(match=>[match.index!,match.index!+match[0].length])
}
