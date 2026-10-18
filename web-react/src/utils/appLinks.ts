export interface AppLink { id:string; orgId:string; label:string; href:string }
// Only this app's canonical hash route. Never turn an external host or an
// arbitrary relative URL into an authenticated app preview request.
export function parseAppLink(text:string):AppLink|null {
  const match=/^\[((?:\\.|[^\]\\\n]){1,240})\]\((#\/apps\/([\w%-]{1,240})\/([\w%.-]{1,600}))\)$/.exec(text)
  if(!match)return null
  try {
    const id=decodeURIComponent(match[3]),orgId=decodeURIComponent(match[4])
    if(!/^[\w-]{1,80}$/.test(id)||!orgId||orgId.length>200||/[\s\u0000-\u001f/#?]/.test(orgId))return null
    return {id,orgId,label:match[1].replace(/\\(.)/g,'$1'),href:`#/apps/${encodeURIComponent(id)}/${encodeURIComponent(orgId)}`}
  }catch{return null}
}
export function appLinksIn(text:string,orgId:string):AppLink[]{
  const links:AppLink[]=[]
  for(const match of text.matchAll(/\[(?:\\.|[^\]\\\n])+\]\(#\/apps\/[^\s)]+\)/g)){
    const link=parseAppLink(match[0]);if(link&&link.orgId===orgId&&!links.some(item=>item.id===link.id))links.push(link)
    if(links.length===3)break
  }
  return links
}
