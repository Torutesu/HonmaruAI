import { isOrgId } from '@honmaru/core/links'
import { hashForApp } from '../utils/route'

type AppActivityPush = {
  type: 'open-app-activity'
  appId?: unknown
  orgId?: unknown
  tableId?: unknown
  rowId?: unknown
}

/** Route an App activity notification without changing the existing card/message paths. */
export function openAppActivityPush(
  data: AppActivityPush | null | undefined,
  actions: { bringForward: () => void; closePanel: () => void; navigate: (hash: string) => void },
): boolean {
  if (data?.type !== 'open-app-activity' || typeof data.appId !== 'string' || !/^[\w-]{1,80}$/.test(data.appId)
    || typeof data.orgId !== 'string' || !isOrgId(data.orgId)) return false

  const hasTable = typeof data.tableId === 'string' && data.tableId.length > 0
  const hasRow = typeof data.rowId === 'string' && data.rowId.length > 0
  if (hasTable !== hasRow) return false
  if (hasTable && (!/^[\w-]{1,100}$/.test(data.tableId as string) || !/^[\w-]{1,100}$/.test(data.rowId as string))) return false

  const conversation = hasTable ? { tableId: data.tableId as string, rowId: data.rowId as string } : undefined
  actions.bringForward()
  actions.closePanel()
  actions.navigate(hashForApp(data.appId, data.orgId, conversation))
  return true
}
