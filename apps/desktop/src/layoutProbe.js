// Runs in the app document. Only bounded flags cross the renderer boundary;
// no text, URLs, attributes, screenshots or credentials are returned.
export const LAYOUT_PROBE = `(() => {
 const body=document.body,root=document.getElementById('root'),startup=document.getElementById('app-startup');
 const hasBox=element=>{if(!element)return false;const r=element.getBoundingClientRect();return r.width>0&&r.height>0};
 const shown=element=>{if(!element)return false;for(let e=element;e;e=e.parentElement){const s=getComputedStyle(e);if(s.display==='none'||s.visibility==='hidden'||s.visibility==='collapse'||Number(s.opacity)===0)return false}return true};
 let flags=0;
 if(root)flags|=1;
 if(root?.childElementCount)flags|=2;
 if(hasBox(root))flags|=4;
 if(shown(root))flags|=8;
 if(body?.innerText.trim())flags|=16;
 if(body&&[...body.querySelectorAll('img,svg,canvas,video,[role="progressbar"]')].some(e=>hasBox(e)&&shown(e)))flags|=32;
 if(hasBox(startup)&&shown(startup))flags|=64;
 return flags;
})()`
