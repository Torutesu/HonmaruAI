// Figma MCP `use_figma` script — rebuilds "A4 Home — Classic" (node 59:164)
// in file ii8w8x7gvN3wp70vlszBSa as a Slack iOS clone, matching the prototype's
// new classicHTML(): workspace header, Jump-to search, Channels / DMs / Apps
// sections, unread bold + red badges, presence dots.
//
// Blocked on 2026-08-07 by the Figma Starter-plan MCP rate limit (the file's
// team is Starter; read-tool budget is monthly). Run via Figma MCP once the
// file moves to a Professional team or the budget resets. Companion fix in
// capture-fix.js should run in the same session.

const page = figma.root.children[0];
await figma.setCurrentPageAsync(page);
const F={
 ib:{family:"Inter",style:"Bold"},
 xbI:{family:"Inter",style:"Extra Bold"},
 ir:{family:"Inter",style:"Regular"},
 im:{family:"Inter",style:"Medium"},
 isb:{family:"Inter",style:"Semi Bold"},
};
await Promise.all(Object.values(F).map(f=>figma.loadFontAsync(f)));
const C=h=>({r:((h>>16)&255)/255,g:((h>>8)&255)/255,b:(h&255)/255});
const S=h=>[{type:"SOLID",color:C(h)}];
function T(txt,font,size,color,o){
  const t=figma.createText(); t.fontName=font; t.fontSize=size; t.characters=txt; t.fills=S(color);
  if(o&&o.ls!==undefined)t.letterSpacing={unit:"PERCENT",value:o.ls};
  if(o&&o.lh)t.lineHeight={unit:"PERCENT",value:o.lh};
  return t;
}
const s=await figma.getNodeByIdAsync("59:164");
// children: [status bar, segmented bar, old content, tab bar, home indicator]
const old=s.children[2];
old.remove();
const c=figma.createAutoLayout("VERTICAL",{name:"Slack clone",itemSpacing:0,paddingBottom:8});
s.insertChild(2,c);
c.fills=S(0xFFFFFF);
c.layoutSizingHorizontal="FILL"; c.layoutSizingVertical="FILL";
// workspace header
const top=figma.createAutoLayout("HORIZONTAL",{paddingLeft:16,paddingRight:16,paddingTop:8,paddingBottom:4,itemSpacing:8});
top.counterAxisAlignItems="CENTER"; c.appendChild(top); top.layoutSizingHorizontal="FILL";
const ws=figma.createAutoLayout("HORIZONTAL",{itemSpacing:4}); ws.counterAxisAlignItems="CENTER";
ws.appendChild(T("Honmaru HQ",F.xbI,19,0x1D1C1D));
ws.appendChild(T("▾",F.ir,11,0x616061));
top.appendChild(ws); ws.layoutSizingHorizontal="FILL";
function iconCircle(glyph){
  const b=figma.createFrame(); b.resize(32,32); b.cornerRadius=999; b.fills=S(0xFFFFFF);
  b.strokes=S(0xDDDDDD); b.strokeWeight=1;
  const g=T(glyph,F.ir,13,0x1D1C1D); b.appendChild(g); g.x=(32-g.width)/2; g.y=(32-g.height)/2;
  return b;
}
top.appendChild(iconCircle("☰"));
top.appendChild(iconCircle("✎"));
// search pill
const search=figma.createAutoLayout("HORIZONTAL",{paddingLeft:12,paddingRight:12,paddingTop:9,paddingBottom:9,itemSpacing:8});
search.cornerRadius=10; search.fills=S(0xF2F2F2); search.counterAxisAlignItems="CENTER";
const searchWrap=figma.createAutoLayout("HORIZONTAL",{paddingLeft:16,paddingRight:16,paddingTop:4,paddingBottom:2});
searchWrap.fills=[]; c.appendChild(searchWrap); searchWrap.layoutSizingHorizontal="FILL";
searchWrap.appendChild(search); search.layoutSizingHorizontal="FILL";
const mag=figma.createNodeFromSvg('<svg width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="11" cy="11" r="7" stroke="#616061" stroke-width="2"/><path d="m20 20-3.5-3.5" stroke="#616061" stroke-width="2" stroke-linecap="round"/></svg>');
mag.resize(15,15); mag.fills=[]; search.appendChild(mag);
search.appendChild(T("Jump to or search…",F.ir,13.5,0x616061));
// helpers
function secHeader(label){
  const h=figma.createAutoLayout("HORIZONTAL",{paddingLeft:16,paddingRight:16,paddingTop:13,paddingBottom:3,itemSpacing:5});
  h.counterAxisAlignItems="CENTER"; h.fills=[];
  c.appendChild(h); h.layoutSizingHorizontal="FILL";
  h.appendChild(T("▼",F.ir,8,0x616061));
  h.appendChild(T(label,F.isb,12.5,0x616061));
}
function row(leadNode,name,prev,time,unread,badge){
  const r=figma.createAutoLayout("HORIZONTAL",{paddingLeft:16,paddingRight:16,paddingTop:6,paddingBottom:6,itemSpacing:10});
  r.counterAxisAlignItems="CENTER"; r.fills=[];
  c.appendChild(r); r.layoutSizingHorizontal="FILL";
  r.appendChild(leadNode);
  const main=figma.createAutoLayout("VERTICAL",{itemSpacing:1});
  r.appendChild(main); main.layoutSizingHorizontal="FILL";
  const l1=figma.createAutoLayout("HORIZONTAL",{itemSpacing:6});
  l1.counterAxisAlignItems="BASELINE"; main.appendChild(l1); l1.layoutSizingHorizontal="FILL";
  const nm=T(name,unread?F.xbI:F.ir,14.5,0x1D1C1D); l1.appendChild(nm); nm.layoutSizingHorizontal="FILL";
  l1.appendChild(T(time,F.ir,10.5,0x616061));
  const pv=T(prev,unread?F.im:F.ir,12,unread?0x1D1C1D:0x616061);
  main.appendChild(pv); pv.layoutSizingHorizontal="FILL"; pv.textAutoResize="HEIGHT"; pv.maxLines=1; pv.textTruncation="ENDING";
  if(badge){
    const b=figma.createAutoLayout("HORIZONTAL",{paddingLeft:6,paddingRight:6,paddingTop:2,paddingBottom:2});
    b.cornerRadius=999; b.fills=S(0xE01E5A); b.primaryAxisAlignItems="CENTER";
    b.appendChild(T(String(badge),F.ib,10.5,0xFFFFFF));
    r.appendChild(b);
  }
}
function hashLead(){
  const f=figma.createFrame(); f.resize(28,28); f.fills=[];
  const g=T("#",F.ir,16,0x616061); f.appendChild(g); g.x=(28-g.width)/2; g.y=(28-g.height)/2;
  return f;
}
function avLead(letter,hex,online){
  const f=figma.createFrame(); f.resize(28,28); f.fills=[]; f.clipsContent=false;
  const sq=figma.createRectangle(); sq.resize(28,28); sq.cornerRadius=6; sq.fills=S(hex); f.appendChild(sq);
  const g=T(letter,F.ib,12.5,0xFFFFFF); f.appendChild(g); g.x=(28-g.width)/2; g.y=(28-g.height)/2;
  const dot=figma.createEllipse(); dot.resize(11,11); dot.x=20; dot.y=20;
  dot.fills=S(online?0x2BAC76:0xFFFFFF);
  dot.strokes=S(online?0xFFFFFF:0x616061); dot.strokeWeight=online?2:1.5;
  f.appendChild(dot);
  return f;
}
// channels
secHeader("Channels");
row(hashLead(),"release","Dana: I think we're ready to ship. Everything through PR214…","6m",true,1);
row(hashLead(),"design","Carol: team is split between warm and monochrome for the…","40m",true,2);
row(hashLead(),"general","Alex: standup notes posted","1d",false,0);
// dms
secHeader("Direct messages");
row(avLead("B",0xE8912D,true),"Bob","▶︎ Voice memo · 0:42","22m",true,1);
row(avLead("D",0x7C3085,true),"Dana","thanks! shipping notes updated","2h",false,0);
row(avLead("C",0x2BAC76,false),"Carol","see you at the crit","3h",false,0);
// apps
secHeader("Apps");
row(avLead("G",0x1D1C1D,false),"GitHub","Merged: fix(auth): cache token validation — deploy verified","1h",true,1);
row(avLead("N",0x616061,false),"Notion","Q3 Planning: Without one more iOS hire the roadmap slips…","2h",true,1);
return { rebuiltScreenId: s.id, newContentId: c.id };
