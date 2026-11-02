// A deterministic host for the actual RowMenu, included only in E2E builds.
import React, { useCallback, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { RowMenu, type MenuEntry } from '../src/components/RowMenu'
import '../src/components/ClassicList.css'

function Fixture() {
  const [unread, setUnread] = useState(false)
  const [star, setStar] = useState(true)
  const [flipped, setFlipped] = useState(false)
  const [copy, setCopy] = useState(true)
  const [action, setAction] = useState('')
  const onClose = useCallback(() => {}, [])
  Object.assign(window, { setUnread, setStar, setFlipped, setCopy })
  const entries: MenuEntry[] = [
    ...(unread ? [
      { kind: 'item' as const, label: 'Mark all as read', data: 'mark-all', onSelect: () => setAction('mark-all') },
      { kind: 'sep' as const },
    ] : []),
    { kind: 'item', label: 'Channel details', data: 'details', onSelect: () => setAction('details') },
    ...(copy ? [{ kind: 'item' as const, label: 'Copy', data: 'copy', submenu: [
      { kind: 'item' as const, label: 'Copy link', data: 'copy-link', onSelect: () => setAction('copy-link') },
    ] }] : []),
    ...(star ? [{ kind: 'item' as const, label: flipped ? 'Unstar channel' : 'Star channel', data: 'star', onSelect: () => setAction(flipped ? 'unstar' : 'star') }] : []),
    { kind: 'item', label: 'Move to a section', data: 'move', onSelect: () => setAction('move') },
  ]
  return <>
    <button id="outside">Outside</button>
    <div id="action">{action}</div>
    <RowMenu at={{ x: 100, y: 100 }} label="Front desk" entries={entries} onClose={onClose} />
  </>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
