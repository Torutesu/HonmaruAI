import React, { useCallback, useState } from 'react'
import { RowMenu } from './RowMenu'
import { Icon } from './Icon'

interface Props {
  label: string
  actionsLabel: string
  openLabel: string
  deleteLabel: string
  onOpen: () => void
  onDelete: () => void
  deleteDisabled?: boolean
}

export const AppRowActions: React.FC<Props> = ({label,actionsLabel,openLabel,deleteLabel,onOpen,onDelete,deleteDisabled=false}) => {
  const [menu,setMenu] = useState<{at:{x:number;y:number};anchor:HTMLButtonElement}|null>(null)
  const close = useCallback(() => setMenu(null),[])
  const toggle = (event:React.MouseEvent<HTMLButtonElement>) => {
    if(menu?.anchor===event.currentTarget){close();return}
    const rect=event.currentTarget.getBoundingClientRect()
    setMenu({anchor:event.currentTarget,at:{x:Math.max(4,rect.right-220),y:rect.bottom}})
  }
  return <div className="hx-record-actions">
    <button type="button" className="hx-record-menu-trigger" aria-label={label+'の操作'} title={label+'の操作'} aria-haspopup="menu" aria-expanded={menu!==null} onClick={toggle}>
      <Icon name="more" size={15}/>
    </button>
    {menu&&<RowMenu at={menu.at} anchor={menu.anchor} label={actionsLabel} onClose={close} entries={[
      {kind:'item',label:openLabel,icon:'maximize',onSelect:onOpen},
      {kind:'item',label:deleteLabel,icon:'trash',danger:true,disabled:deleteDisabled,onSelect:onDelete},
    ]}/>}
  </div>
}
