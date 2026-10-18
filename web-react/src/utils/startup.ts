// A slow language chunk must not hold the entire UI behind an empty root.
// i18n notifies mounted subscribers when the translation eventually arrives.
export function startAfterLocale(locale:Promise<unknown>,start:()=>void,waitMs=2000):void {
  let finished=false
  const finish=()=>{if(finished)return;finished=true;clearTimeout(timer);start()}
  const timer=setTimeout(finish,waitMs)
  void locale.then(finish,finish)
}
