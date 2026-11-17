import React,{useMemo} from 'react'
import {workspaceFileApi} from '../utils/workspaceFiles'
import {useWorkspaceFilePins} from '../utils/workspaceFilePins'
import {hashForFileView} from '../utils/route'
import {Icon} from './Icon'
import {useT} from '../utils/i18n'

export function HarnessPinnedFiles({httpBase,orgId,sessionToken}:{httpBase:string;orgId:string;sessionToken:string}){
 const t=useT(),api=useMemo(()=>workspaceFileApi(httpBase,orgId,sessionToken),[httpBase,orgId,sessionToken]),{pins}=useWorkspaceFilePins(orgId,api)
 return pins.length?<div className="hx-pinned-apps hx-pinned-files" role="group" aria-label={t('Pinned files')}>{pins.map(file=><button key={file.id} className="hx-pinned-app" title={file.path} aria-label={t('Open {name}',{name:file.path.split('/').at(-1)||file.path})} onClick={()=>{location.hash=hashForFileView(file.scope,orgId,file.id)}}><Icon name="file" size={17}/></button>)}</div>:null
}
