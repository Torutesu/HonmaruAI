import React from 'react'

type SavedSidebar = {
  starred: string[]
  sections: Array<{id: string; name: string; views: string[]; collapsed?: boolean}>
  order?: string[]
}

// Read-only evidence for the person deciding whether to discard local edits.
// Include all layout properties, including those not visible as stars.
export function SidebarSavedState({sidebar, nameOf, japanese}: {sidebar: SavedSidebar; nameOf: (view: string) => string; japanese: boolean}) {
  const names = (views: string[]) => views.map(nameOf).join(', ') || '—'
  return <div aria-label={japanese ? '保存されているサイドバー' : 'Saved sidebar'}>
    <p>{japanese ? 'サーバー上の固定:' : 'Saved stars:'} {names(sidebar.starred)}</p>
    <p>{japanese ? 'サーバー上のチャンネル順:' : 'Saved channel order:'} {sidebar.order?.length ? names(sidebar.order) : japanese ? '既定の順序' : 'Default order'}</p>
    {sidebar.sections.map(section => <p key={section.id}>{section.name} ({section.collapsed ? japanese ? '折りたたみ' : 'Collapsed' : japanese ? '展開中' : 'Expanded'}): {names(section.views)}</p>)}
  </div>
}
