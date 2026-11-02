import React, {useEffect, useRef, useState} from 'react'
import {Dialog} from './Dialog'
import {useT} from '../utils/i18n'
import {getLocale,primary} from '../utils/locale'
import {HarnessApiError} from '../utils/harness'
import './AppRowDeleteConfirm.css'

const copy:Record<string,{description:string;pending:string;rejected:string;uncertain:string}>={
 en:{description:'This permanently deletes the record and cannot be undone.',pending:'Deleting…',rejected:'An error response was received. Close this dialog and refresh the view to check the record.',uncertain:'The result could not be confirmed. If the response was lost, the original request may finish even after a refresh. Close this dialog and refresh to check; deleting again sends a new request.'},
 ja:{description:'このレコードを完全に削除します。元には戻せません。',pending:'削除中…',rejected:'エラー応答を受け取りました。閉じて画面を更新し、レコードの状態を確認してください。',uncertain:'削除結果を確認できませんでした。応答が届かなかった場合、元の要求は更新後にも完了する可能性があります。閉じて更新し、状態を確認してください。再度削除すると新たな要求を送ります。'},
 es:{description:'Este registro se eliminará permanentemente. Esta acción no se puede deshacer.',pending:'Eliminando…',rejected:'Se recibió una respuesta de error. Cierra este diálogo y actualiza la vista para comprobar el registro.',uncertain:'No se pudo confirmar el resultado. Si se perdió la respuesta, la solicitud original puede terminar después de actualizar. Cierra el diálogo y actualiza para comprobarlo; volver a eliminar envía otra solicitud.'},
 fr:{description:'Cet enregistrement sera supprimé définitivement. Cette action est irréversible.',pending:'Suppression…',rejected:'Une réponse d’erreur a été reçue. Fermez cette fenêtre et actualisez la vue pour vérifier l’enregistrement.',uncertain:'Le résultat n’a pas pu être confirmé. Si la réponse a été perdue, la demande initiale peut aboutir après l’actualisation. Fermez cette fenêtre et actualisez pour vérifier ; supprimer à nouveau envoie une nouvelle demande.'},
 de:{description:'Dieser Datensatz wird dauerhaft gelöscht. Dies kann nicht rückgängig gemacht werden.',pending:'Wird gelöscht…',rejected:'Eine Fehlerantwort ist eingegangen. Schließe den Dialog und aktualisiere die Ansicht, um den Datensatz zu prüfen.',uncertain:'Das Ergebnis konnte nicht bestätigt werden. Falls die Antwort verloren ging, kann die ursprüngliche Anfrage auch nach dem Aktualisieren abgeschlossen werden. Schließe den Dialog und aktualisiere zur Prüfung; erneutes Löschen sendet eine neue Anfrage.'},
}
const DELETE_WAIT_MS=15_000

// A row deletion cannot be undone in the app. Keep its observed identity and
// version bound to the explicit confirmation, and do not repeat an uncertain
// request without first refreshing the record list.
export function AppRowDeleteConfirm({label,rowId,uncertain=false,initialReason='',onDelete,onDeleted,onClose,onUncertain}:{label:string;rowId:string;uncertain?:boolean;initialReason?:string;onDelete:()=>Promise<void>;onDeleted:()=>void;onClose:()=>void;onUncertain:(reason:string)=>void}) {
 const t=useT(),[busy,setBusy]=useState(false),[failed,setFailed]=useState(uncertain),[reason,setReason]=useState(initialReason),pending=useRef(false),active=useRef(true),text=copy[primary(getLocale())]||copy.en
 useEffect(()=>{active.current=true;return()=>{active.current=false}},[])
 const close=()=>{if(!pending.current)onClose()}
 const submit=async()=>{
  if(pending.current||failed)return
  pending.current=true;setBusy(true)
  let timer:ReturnType<typeof setTimeout>|undefined
  try{await Promise.race([onDelete(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Deletion acknowledgement timed out.')),DELETE_WAIT_MS)})]);if(active.current)onDeleted()}
  catch(error){if(active.current){const message=error instanceof HarnessApiError&&error.status>=400&&error.status<500&&error.status!==408?error.message:'';setFailed(true);setReason(message);onUncertain(message)}}
  finally{if(timer!==undefined)clearTimeout(timer);pending.current=false;if(active.current)setBusy(false)}
 }
 return <Dialog className="app-row-delete" title={t('Delete row')} lede={text.description} onClose={close} footer={<><button type="button" className="dlg-btn" disabled={busy} onClick={close}>{t('Cancel')}</button><button type="button" className="dlg-btn danger" disabled={busy||failed} onClick={()=>void submit()}>{busy?text.pending:t('Delete')}</button></>}>
  <p><strong>{label}</strong></p><p>ID: <code>{rowId}</code></p>
  {failed&&<p role="alert" className="dlg-error">{reason?`${reason} ${text.rejected}`:text.uncertain}</p>}
 </Dialog>
}
