import React from 'react'

export function DraftSuggestion({draft,onAppend,onDismiss}:{draft:string;onAppend:()=>void;onDismiss:()=>void}) {
 if(!draft)return null
 return <aside className="hx-chat-draft-suggestion" aria-label="今回の調整案">
  <div><strong>今回の調整案</strong><span>未送信の下書きはそのまま保持しています。</span></div>
  <p>{draft}</p>
  <footer><button type="button" onClick={onAppend}>既存の下書きに追加</button><button type="button" onClick={onDismiss}>今回は使わない</button></footer>
 </aside>
}
