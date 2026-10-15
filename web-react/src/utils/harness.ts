import { useCallback, useEffect, useState } from 'react'

// The harness (docs/kylon-gap-plan.md), as the web app talks to it: the
// workspace's mode, and the Apps, Tables, Workflows, Follow-ups, Approvals,
// Skills and agent profiles under it. A workspace in "simple" mode shows
// none of it — the feed and the chat, as Honmaru always was.

export type WorkspaceMode = 'simple' | 'harness'

export type ColumnType = 'text' | 'number' | 'date' | 'select' | 'checkbox' | 'url' | 'person' | 'email'
export interface Column { id: string; name: string; type: ColumnType; options?: string[] }
export interface Table { id: string; name: string; columns: Column[] }
export interface Row { id: string; values: Record<string, unknown>; updatedAt: string }
export interface Metric { label: string; op: string; column?: string; value: number | null }
export interface View {
  id: string
  type: 'table' | 'board' | 'metrics'
  name: string
  groupBy?: string
  sort?: string
  rows?: Row[]
  lanes?: Array<{ key: string | null; rows: Row[] }>
  values?: Metric[]
}
export interface App {
  id: string; name: string; description: string; icon: string; tableId: string
  template: string | null; version: number; channels?: string[]; createdBy: string; updatedAt: string
}
export interface Template { id: string; name: string; icon: string; description: string }

export type TriggerType = 'manual' | 'schedule' | 'webhook' | 'row'
export interface Trigger {
  type: TriggerType
  tableId?: string; on?: 'added' | 'changed' | 'any'; where?: Record<string, string[]>; column?: string
  cadence?: string; hour?: number; minute?: number; weekday?: number; monthday?: number; timezone?: string
}
export type StepType = 'post' | 'agent' | 'add_row' | 'update_row' | 'approval' | 'followup'
export interface Step {
  type: StepType
  channel?: string; text?: string; agentId?: string; prompt?: string; tableId?: string
  values?: Record<string, string>; to?: string; title?: string; summary?: string; minutes?: number
}
export interface Workflow {
  id: string; name: string; enabled: boolean; trigger: Trigger; steps: Step[]
  nextRunAt: string | null; lastRunAt: string | null; createdBy: string; hookUrl?: string
}
export interface RunLog { step: number; type: StepType; status: string; output?: string; error?: string; at: string }
export interface Run { id: string; trigger: string; status: string; log: RunLog[]; startedAt: string; finishedAt: string | null; cardId: string | null }
export interface Followup { id: string; channel: string; instruction: string; dueAt: string; status: string; agentId: string | null }
export interface Skill { id: string; name: string; description: string; body: string; agents?: string[]; createdBy: string }
export interface AgentProfile { specialty: string; tier: 'lite' | 'standard' | 'max'; mentionOnly: boolean; access: 'everyone' | 'people' | 'private'; people: string[] }
export interface AgentMemory { id: string; text: string; source: string; createdAt: string }

/// One client for every harness route: the session on each call, the
/// server's own message on a refusal.
export function harnessApi(httpBase: string, orgId: string, sessionToken: string) {
  const headers = { 'content-type': 'application/json', 'x-session-token': sessionToken }
  const withOrg = (path: string, query: Record<string, string> = {}) => {
    const q = new URLSearchParams({ orgId, ...query })
    return `${httpBase}${path}${path.includes('?') ? '&' : '?'}${q.toString()}`
  }
  async function call<T>(method: string, path: string, body?: Record<string, unknown>, query?: Record<string, string>): Promise<T> {
    const read = method === 'GET' || method === 'DELETE'
    const res = await fetch(read ? withOrg(path, query) : `${httpBase}${path}`, {
      method, headers, body: read ? undefined : JSON.stringify({ orgId, ...(body || {}) }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.message || `${res.status}`)
    return data as T
  }
  return {
    getMode: () => call<{ mode: WorkspaceMode; canEdit: boolean }>('GET', '/orgs/mode'),
    setMode: (mode: WorkspaceMode) => call<{ mode: WorkspaceMode; canEdit: boolean }>('PUT', '/orgs/mode', { mode }),

    templates: () => call<{ templates: Template[] }>('GET', '/apps/templates'),
    apps: (channel?: string) => call<{ apps: App[] }>('GET', '/apps', undefined, channel ? { channel } : {}),
    app: (id: string) => call<{ app: App; table: Table; rows: Row[]; views: View[] }>('GET', `/apps/${id}`),
    createFromTemplate: (template: string, channel?: string) => call<{ app: App }>('POST', '/apps', { template, channel }),
    generate: (prompt: string, channel?: string) => call<{ app: App; source: 'model' | 'template'; room: string | null }>('POST', '/apps/generate', { prompt, channel }),
    updateApp: (id: string, patch: Record<string, unknown>) => call<{ app: App }>('PUT', `/apps/${id}`, patch),
    deleteApp: (id: string) => call<{ deleted: boolean }>('DELETE', `/apps/${id}`),
    versions: (id: string) => call<{ versions: Array<{ version: number; note: string | null; createdAt: string }> }>('GET', `/apps/${id}/versions`),
    restore: (id: string, version: number) => call<{ app: App }>('POST', `/apps/${id}/versions`, { version }),
    link: (id: string, channel: string) => call<{ linked: boolean }>('POST', `/apps/${id}/links`, { channel }),
    unlink: (id: string, channel: string) => call<{ unlinked: boolean }>('DELETE', `/apps/${id}/links`, undefined, { channel }),

    tables: () => call<{ tables: Table[] }>('GET', '/tables'),
    addRow: (tableId: string, values: Record<string, unknown>) => call<{ row: Row }>('POST', `/tables/${tableId}/rows`, { values }),
    updateRow: (tableId: string, rowId: string, values: Record<string, unknown>) => call<{ row: Row }>('PATCH', `/tables/${tableId}/rows/${rowId}`, { values }),
    deleteRow: (tableId: string, rowId: string) => call<{ deleted: boolean }>('DELETE', `/tables/${tableId}/rows/${rowId}`),

    workflows: () => call<{ workflows: Workflow[] }>('GET', '/workflows'),
    workflow: (id: string) => call<{ workflow: Workflow; runs: Run[]; canEdit: boolean }>('GET', `/workflows/${id}`),
    createWorkflow: (w: { name: string; trigger: Trigger; steps: Step[] }) => call<{ workflow: Workflow; hookUrl?: string }>('POST', '/workflows', w as unknown as Record<string, unknown>),
    updateWorkflow: (id: string, patch: Record<string, unknown>) => call<{ workflow: Workflow }>('PUT', `/workflows/${id}`, patch),
    deleteWorkflow: (id: string) => call<{ deleted: boolean }>('DELETE', `/workflows/${id}`),
    runWorkflow: (id: string, text: string) => call<{ run: Run }>('POST', `/workflows/${id}/run`, { text }),

    followups: (channel?: string) => call<{ followups: Followup[] }>('GET', '/followups', undefined, channel ? { channel } : {}),
    cancelFollowup: (id: string) => call<{ cancelled: boolean }>('DELETE', `/followups/${id}`),
    approvals: () => call<{
      toDecide: Array<{ id: string; title: string; summary?: string; kind: string; source: string | null; createdAt: string }>
      waitingOnOthers: Array<{ runId: string; workflowId: string; workflow: string; cardId: string; startedAt: string }>
    }>('GET', '/approvals'),

    skills: () => call<{ skills: Skill[] }>('GET', '/skills'),
    createSkill: (s: { name: string; description?: string; body: string }) => call<{ skill: Skill }>('POST', '/skills', s),
    updateSkill: (id: string, s: Partial<Skill>) => call<{ skill: Skill }>('PUT', `/skills/${id}`, s as Record<string, unknown>),
    deleteSkill: (id: string) => call<{ deleted: boolean }>('DELETE', `/skills/${id}`),

    profile: (agentId: string) => call<{ profile: AgentProfile; canEdit: boolean }>('GET', `/hx/agents/${agentId}/profile`),
    saveProfile: (agentId: string, p: Partial<AgentProfile>) => call<{ profile: AgentProfile }>('PUT', `/hx/agents/${agentId}/profile`, p as Record<string, unknown>),
    memory: (agentId: string) => call<{ memories: AgentMemory[]; canEdit: boolean }>('GET', `/hx/agents/${agentId}/memory`),
    remember: (agentId: string, text: string) => call<{ memory: AgentMemory }>('POST', `/hx/agents/${agentId}/memory`, { text }),
    forget: (agentId: string, id: string) => call<{ deleted: number }>('DELETE', `/hx/agents/${agentId}/memory`, undefined, { id }),
    agentSkills: (agentId: string) => call<{ skills: Skill[] }>('GET', `/hx/agents/${agentId}/skills`),
    giveSkill: (agentId: string, skillId: string) => call<{ given: boolean }>('POST', `/hx/agents/${agentId}/skills`, { skillId }),
    takeSkill: (agentId: string, skillId: string) => call<{ taken: boolean }>('DELETE', `/hx/agents/${agentId}/skills`, undefined, { skillId }),
  }
}

export type HarnessApi = ReturnType<typeof harnessApi>

const MODE_KEY = (orgId: string) => `hx.mode.${orgId}`

/// The workspace's mode: the last one seen first (so the rail does not
/// jump on every load), then the server's. "simple" until told otherwise.
export function useWorkspaceMode(httpBase: string, orgId: string, sessionToken: string) {
  const [mode, setModeState] = useState<WorkspaceMode>(() => {
    try { return (localStorage.getItem(MODE_KEY(orgId)) as WorkspaceMode) === 'harness' ? 'harness' : 'simple' } catch { return 'simple' }
  })
  const [canEdit, setCanEdit] = useState(false)
  const remember = (m: WorkspaceMode) => { try { localStorage.setItem(MODE_KEY(orgId), m) } catch { /* private window */ } }
  useEffect(() => {
    let live = true
    if (!orgId || !sessionToken) return
    harnessApi(httpBase, orgId, sessionToken).getMode()
      .then((d) => { if (!live) return; setModeState(d.mode); setCanEdit(d.canEdit); remember(d.mode) })
      .catch(() => { /* a workspace that cannot answer stays as it was */ })
    const onChange = (e: Event) => {
      const next = (e as CustomEvent<{ orgId: string; mode: WorkspaceMode }>).detail
      if (next?.orgId === orgId) setModeState(next.mode)
    }
    window.addEventListener('hx-mode', onChange)
    return () => { live = false; window.removeEventListener('hx-mode', onChange) }
  }, [httpBase, orgId, sessionToken])
  const setMode = useCallback(async (next: WorkspaceMode) => {
    const d = await harnessApi(httpBase, orgId, sessionToken).setMode(next)
    setModeState(d.mode)
    remember(d.mode)
    window.dispatchEvent(new CustomEvent('hx-mode', { detail: { orgId, mode: d.mode } }))
    return d.mode
  }, [httpBase, orgId, sessionToken])
  return { mode, canEdit, setMode }
}

/// A cell as the table shows it.
export function cellText(column: Column, value: unknown): string {
  if (value == null || value === '') return ''
  if (column.type === 'checkbox') return value ? '✓' : ''
  if (column.type === 'number' && typeof value === 'number') return value.toLocaleString()
  if (column.type === 'person') return `@${value}`
  return String(value)
}

export function metricText(m: Metric): string {
  if (m.value == null) return '—'
  return typeof m.value === 'number' ? m.value.toLocaleString() : String(m.value)
}
