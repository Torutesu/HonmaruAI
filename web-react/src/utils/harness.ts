export interface SkillFile { path: string; base64: string; size?: number }
export type SkillDraft = Pick<Skill, 'name' | 'description' | 'body' | 'metadata'> & { files?: SkillFile[] }
export type SkillImportInput = string | { zipBase64: string } | { files: SkillFile[] }
export interface AppMessage { id:number; authorId:string; authorName:string; body:string; createdAt:string }
export interface AppConversation { threadId:string; messages:AppMessage[]; hasMore:boolean; source?:{channel:string;threadId:string;messages:Array<{id:string;body:string;authorName?:string;kind?:string;createdAt:string}>}|null; aiReplies?:Array<{messageId:number;status:string;error?:string}> }
export interface PersonalViews { activeView?: string; revision: number; views: View[]; computed: View[]; layouts: Record<string, {order:string[];widths:Record<string,number>;hidden?:string[];wrapText?:boolean}> }
import { useCallback, useEffect, useState } from 'react'

// The harness (docs/kylon-gap-plan.md), as the web app talks to it: the
// workspace's mode, and the Apps, Tables, Workflows, Follow-ups, Approvals,
// Skills and agent profiles under it. A workspace in "simple" mode shows
// none of it — the feed and the chat, as Honmaru always was.

export type WorkspaceMode = 'simple' | 'harness'

export type ColumnType = 'text' | 'number' | 'date' | 'select' | 'checkbox' | 'url' | 'person' | 'email'
export interface Column { id: string; name: string; type: ColumnType; options?: string[] }
export interface Table { id: string; name: string; columns: Column[] }
export interface Row { createdAt?: string; id: string; values: Record<string, unknown>; updatedAt: string }
export interface Metric { label: string; op: string; column?: string; value: number | null }
export interface View {
  id: string
  type: 'table' | 'board' | 'metrics' | 'calendar'
  name: string
  dateColumn?: string
  days?: Array<{ date: string; rows: Row[] }>
  undated?: Row[]
  filters?: Array<{column: string; op: string; value: string}>
  where?: Record<string, string[]>
  groupBy?: string
  sort?: string
  rows?: Row[]
  lanes?: Array<{ key: string | null; rows: Row[] }>
  values?: Metric[]
}
export interface App {
  definition: { views: View[]; custom?: { draft?: string; published?: string; publishedAt?: string } }
  id: string; name: string; description: string; icon: string; tableId: string
  template: string | null; version: number; channels?: string[]; createdBy: string; updatedAt: string
}
export interface AppAction { name: string; version: number; draft?: string; published: string | null; publishedVersion: number | null }
export interface AppConnection { name: string; version: number; endpoint: string; method: string; enabled: number; hasToken: number }
export interface AppEntity { key: string; table: Table; rows?: Row[] }
export interface AppFork { id: string; revision: number; mergedAt?: string | null; entities: Array<AppEntity & { rows: Row[] }> }
export interface MergeReview { forkId: string; revision: number; checksum: string; changes: Array<{entity:string;tableId:string;tableName:string;id:string;operation:'create'|'update'|'remove';before:Record<string,unknown>|null;after:Record<string,unknown>|null}>; conflicts: Array<{entity:string;id:string;reason:string}> }
export interface AppDatabase { version: number; entities: AppEntity[]; migrations: Array<{id:string;version:number;checksum:string;plan:unknown;createdAt:string}>; fork: AppFork | null }
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
  nextRunAt: string | null; lastRunAt: string | null; createdBy: string; hookUrl?: string; hookSecret?: string
}
export type AutomationDefinition = Pick<Workflow, 'name' | 'enabled' | 'trigger' | 'steps'>
export interface AutomationBundle { version: 1; items: Array<AutomationDefinition & {key: string}> }
export interface AutomationPlanItem { key: string; workflowId: string | null; status: 'added'|'changed'|'unchanged'|'removed'|'retired'|'drifted'|'missing'; declared: AutomationDefinition | null; published: AutomationDefinition | null; live: AutomationDefinition | null }
export interface AppAutomationState { version: number; revision: number; draft: AutomationBundle; published: AutomationBundle | null; releaseId: string | null; publishedAt: string | null; plan?: AutomationPlanItem[] }
export interface RunLog { step: number; type: StepType; status: string; output?: string; error?: string; at: string }
export interface HeldWorkflowEvents { count: number; oldestExpiry: string | null; events: Array<{ id: string; receivedAt: string; expiresAt: string }>; discardEventIds?: string[] }
export interface Run { id: string; trigger: string; status: string; log: RunLog[]; startedAt: string; finishedAt: string | null; cardId: string | null }
export interface Followup { id: string; threadId?: string | null; channel: string; instruction: string; dueAt: string; status: string; agentId: string | null; result?: string | null; doneAt?: string | null }
export interface Gateway { id: string; name: string; createdAt: number; lastSeenAt: number | null; revokedAt: number | null }
export interface GatewayJob { id: string; gatewayId: string; status: string; createdAt: number; result: { stdout?: string; stderr?: string; error?: string; exitCode?: number | null } | null }
export interface Skill { sourceScope?: { agentId: string; channel: string | null } | null; createdByName?: string; metadata?: Record<string, unknown>; visibility?: 'workspace' | 'private'; accessVersion?: number; canShare?: boolean; canEdit?: boolean; id: string; name: string; description: string; body: string; agents?: string[]; createdBy: string }
export interface AgentRoleState { version: number; scope: 'team' | 'personal'; canManage: boolean; canAddMembers?: boolean; members: Array<{ref: string; name: string; role: 'admin' | 'member'; owner: boolean; mine?: boolean}>; candidates: Array<{ref: string; name: string}> }
export interface AgentProfile { specialty: string; tier: 'lite' | 'standard' | 'max'; mentionOnly: boolean; access: 'everyone' | 'people' | 'private'; people: string[] }
export interface HomeData {
  mode: WorkspaceMode
  approvals: {
    pendingDecisions: number
    toDecide: Array<{ id: string; title: string; summary?: string; kind: string; source: string | null; createdAt: string }>
    waitingOnOthers: Array<{ runId: string; workflow: string; startedAt: string }>
  }
  apps: Array<{ id: string; name: string; icon: string; description: string; channels: string[]; rows: number; headline: { label: string; value: number | null } | null }>
  agents: Array<{ id: string; handle: string; name: string; emoji: string | null; description: string; specialty: string; tier: string; provider: string | null }>
  workflows: Array<{ id: string; name: string; enabled: boolean; trigger: TriggerType; nextRunAt: string | null; lastRun: { status: string; startedAt: string } | null }>
  followups: Followup[]
}
export type MemoryKind = 'context' | 'preference' | 'feedback' | 'reference'
export interface MemoryEntryInput { title: string; description: string; body: string; kind: MemoryKind }
export interface MemoryReview { id: string; memoryId?: string; version: number; verdict: string; evidence: string; by: string; reviewerName: string; at: string }
export interface AgentMemory { review?: { version: number; evidence: string; by: string; at: string; current: boolean } | null; title?: string; description?: string; body?: string; version?: number; updatedAt?: string; id: string; text: string; source: string; createdAt: string; channel?: string | null; kind?: string }

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
    httpBase, orgId,
    conversation: (id:string, scope:{tableId?:string;rowId?:string}={}, before?:number) => call<AppConversation>('GET',`/apps/${id}/conversation`,undefined,{...(scope.tableId?{tableId:scope.tableId}:{}),...(scope.rowId?{rowId:scope.rowId}:{}),...(before?{before:String(before)}:{})}),
    postConversation: (id:string, scope:{tableId?:string;rowId?:string}, body:string, requestId:string) => call<{threadId:string;messageId:number}>('POST',`/apps/${id}/conversation`,{...scope,body,requestId}),
    markSourceRead: (channel:string,thread:string,at:string) => call('POST','/channels/read',{channel,thread,at}),
    conversationSources: (id:string) => call<{candidates:Array<{id:string;body:string;channel:string;createdAt:string}>}>('GET',`/apps/${id}/conversation-source`),
    inheritConversation: (id:string,messageId:string) => call('POST',`/apps/${id}/conversation-source`,{messageId}),
    conversationNotifications: (id:string) => call<{items:Array<{messageId:number;body:string;tableId:string;rowId:string;readAt:string|null;kind:string}>}>('GET',`/apps/${id}/conversation-notifications`),
    readConversationNotification: (id:string,messageId:number) => call('POST',`/apps/${id}/conversation-notifications`,{messageId}),
    members: () => call<{members:Array<{ref:string;name:string}>}>('GET','/members'),
    personalViews: (id:string) => call<PersonalViews>('GET', `/hx/personal-views/${id}`),
    savePersonalViews: (id:string, state:PersonalViews) => call<PersonalViews>('PUT', `/hx/personal-views/${id}`, {expectedRevision:state.revision,views:state.views,layouts:state.layouts,activeView:state.activeView}),
    appPins: () => call<{pins:string[]}>('GET', '/hx/app-pins'),
    setAppPin: (appId:string,pinned:boolean) => call<{pins:string[]}>('PUT','/hx/app-pins',{appId,pinned}),
    gateways: () => call<{ gateways: Gateway[]; canManage: boolean }>('GET', '/gateways'),
    registerGateway: (name: string) => call<{ gateway: Gateway; token: string }>('POST', '/gateways', { name }),
    revokeGateway: (id: string) => call('POST', `/gateways/${encodeURIComponent(id)}/revoke`),
    gatewayJobs: () => call<{ jobs: GatewayJob[] }>('GET', '/gateways/jobs'),
    execute: (gatewayId: string, code: string, input: unknown, requestId: string) => call<{ job: GatewayJob }>('POST', '/gateways/jobs', { gatewayId, code, input, requestId }),
    cancelExecution: (id: string) => call('POST', `/gateways/jobs/${encodeURIComponent(id)}/cancel`),
    home: () => call<HomeData>('GET', '/harness/home'),
    getMode: () => call<{ mode: WorkspaceMode; canEdit: boolean }>('GET', '/orgs/mode'),
    setMode: (mode: WorkspaceMode) => call<{ mode: WorkspaceMode; canEdit: boolean }>('PUT', '/orgs/mode', { mode }),

    templates: () => call<{ templates: Template[] }>('GET', '/apps/templates'),
    apps: (channel?: string) => call<{ apps: App[] }>('GET', '/apps', undefined, channel ? { channel } : {}),
    app: (id: string) => call<{ app: App; table: Table; rows: Row[]; views: View[]; canCustomize: boolean }>('GET', `/apps/${id}`),
    createFromTemplate: (template: string, channel?: string) => call<{ app: App }>('POST', '/apps', { template, channel }),
    generate: (prompt: string, channel?: string, generation?: {requestId:string;captureSource?:boolean;sourceThreadId?:string}) => call<{ app: App; source: 'model' | 'template'; room: string | null }>('POST', '/apps/generate', { prompt, channel, ...generation }),
    updateApp: (id: string, patch: Record<string, unknown>) => call<{ app: App }>('PUT', `/apps/${id}`, patch),
    generateCustom: (id: string, prompt: string) => call<{ html: string }>('POST', `/apps/${id}/custom`, { action: 'generate', prompt }),
    saveCustom: (id: string, action: 'draft' | 'publish' | 'unpublish' | 'restore', version: number, html?: string, restoreVersion?: number) => call('POST', `/apps/${id}/custom`, { action, version, html, restoreVersion }),
    appAutomations: (id: string, stateOnly = false) => call<AppAutomationState>('GET', `/apps/${id}/automations`, undefined, stateOnly ? {stateOnly:'1'} : {}),
    saveAppAutomations: (id: string, version: number, revision: number, automations: AutomationBundle) => call<{saved:boolean;revision:number}>('PUT', `/apps/${id}/automations`, {version,revision,automations}),
    releaseAppAutomations: (id: string, body: Record<string,unknown>) => call<{saved:boolean;revision:number;version:number;replay?:boolean}>('POST', `/apps/${id}/automations`, body),
    appDatabase: (id: string) => call<AppDatabase>('GET', `/apps/${id}/database`),
    mergePreview: (id: string, fork: AppFork) => call<MergeReview>('POST', `/apps/${id}/database`, { action:'merge_preview',forkId:fork.id,revision:fork.revision }),
    databaseChange: (id: string, body: Record<string, unknown>) => call<{operations?: unknown[]; fork?: AppFork; revision?: number; result?: unknown; review?: MergeReview}>('POST', `/apps/${id}/database`, body),
    appActions: (id: string) => call<{actions: AppAction[]}>('GET', `/apps/${id}/actions`),
    actionChange: (id: string, body: Record<string, unknown>) => call<{name?: string;code?: string;job?: GatewayJob}>('POST', `/apps/${id}/actions`, body),
    actionHistory: (id: string, name: string) => call<{versions:Array<{version:number;code:string;createdAt:string}>}>('GET', `/apps/${id}/actions`, undefined, {history:name}),
    actionJob: (id: string, jobId: string) => call<{job: GatewayJob}>('GET', `/apps/${id}/actions`, undefined, {jobId}),
    appConnections: (id: string) => call<{connections: AppConnection[];hosts: string[]}>('GET', `/apps/${id}/connections`),
    connectionChange: (id: string, body: Record<string, unknown>) => call<{data?: unknown}>('POST', `/apps/${id}/connections`, body),
    entityRows: (tableId: string) => call<{table: Table; rows: Row[]}>('GET', `/tables/${tableId}`, undefined, {limit:'5000'}),
    deleteApp: (id: string) => call<{ deleted: boolean }>('DELETE', `/apps/${id}`),
    versions: (id: string) => call<{ versions: Array<{ version: number; note: string | null; createdAt: string }> }>('GET', `/apps/${id}/versions`),
    restore: (id: string, version: number) => call<{ app: App }>('POST', `/apps/${id}/versions`, { version }),
    link: (id: string, channel: string) => call<{ linked: boolean }>('POST', `/apps/${id}/links`, { channel }),
    unlink: (id: string, channel: string) => call<{ unlinked: boolean }>('DELETE', `/apps/${id}/links`, undefined, { channel }),

    tables: () => call<{ tables: Table[] }>('GET', '/tables'),
    addRow: (tableId: string, values: Record<string, unknown>, validation?: 'strict') => call<{ row: Row }>('POST', `/tables/${tableId}/rows`, { values, validation }),
    updateRow: (tableId: string, rowId: string, values: Record<string, unknown>, expectedUpdatedAt?: string, validation?: 'strict') => call<{ row: Row }>('PATCH', `/tables/${tableId}/rows/${rowId}`, { values, expectedUpdatedAt, validation }),
    deleteRow: (tableId: string, rowId: string, expectedUpdatedAt?: string) => call<{ deleted: boolean }>('DELETE', `/tables/${tableId}/rows/${rowId}`, undefined, expectedUpdatedAt ? { expectedUpdatedAt } : {}),

    workflows: () => call<{ workflows: Workflow[] }>('GET', '/workflows'),
    workflow: (id: string) => call<{ workflow: Workflow; runs: Run[]; canEdit: boolean; held?: HeldWorkflowEvents }>('GET', `/workflows/${id}`),
    generateWorkflow: (prompt: string, channel?: string) => call<{ workflow: Workflow; source: string }>('POST', '/workflows/generate', { prompt, channel, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    createWorkflow: (w: { name: string; trigger: Trigger; steps: Step[] }) => call<{ workflow: Workflow; hookUrl?: string }>('POST', '/workflows', w as unknown as Record<string, unknown>),
    updateWorkflow: (id: string, patch: Record<string, unknown>) => call<{ workflow: Workflow }>('PUT', `/workflows/${id}`, patch),
    changeWorkflowHook: (id: string, action: 'rotate' | 'revoke', expectedSecret: string | null) => call<{ workflow: Workflow }>('POST', `/workflows/${id}/webhook`, { action, expectedSecret }),
    replayWorkflowEvents: (id: string, eventIds: string[]) => call<{ runs: Array<{ eventId: string; runId: string; status: string }>; skipped: number }>('POST', `/workflows/${id}/webhook/replay`, { eventIds }),
    heldWorkflowEvent: (id: string, eventId: string) => call<{ event: { id: string; receivedAt: string; expiresAt: string; input: unknown } }>('GET', `/workflows/${id}/webhook/events/${encodeURIComponent(eventId)}`),
    discardWorkflowEvents: (id: string, eventIds: string[]) => call<{ discarded: number }>('POST', `/workflows/${id}/webhook/discard`, { eventIds }),
    deleteWorkflow: (id: string) => call<{ deleted: boolean }>('DELETE', `/workflows/${id}`),
    runWorkflow: (id: string, text: string) => call<{ run: Run }>('POST', `/workflows/${id}/run`, { text }),

    followups: (channel?: string, status = 'scheduled', agentId?: string) => call<{ followups: Followup[] }>('GET', '/followups', undefined, { ...(channel ? { channel } : {}), ...(agentId ? { agentId } : {}), status }),
    followupHistory: (agentId: string, status: string, cursor?: string) => call<{ followups: Followup[]; nextCursor: string | null }>('GET', '/followups', undefined, { agentId, status, paged: '1', ...(cursor ? { cursor } : {}) }),
    cancelFollowup: (id: string) => call<{ cancelled: boolean }>('DELETE', `/followups/${id}`),
    approvals: () => call<{
      toDecide: Array<{ id: string; title: string; summary?: string; kind: string; source: string | null; createdAt: string }>
      waitingOnOthers: Array<{ runId: string; workflowId: string; workflow: string; cardId: string; startedAt: string }>
    }>('GET', '/approvals'),

    skills: () => call<{ skills: Skill[] }>('GET', '/skills'),
    previewSkillImport: (input: SkillImportInput) => call<{ draft: SkillDraft }>('POST', '/skills/preview-import', typeof input === 'string' ? { markdown: input } : input),
    exportSkillPackage: async (id: string) => {
      const response = await fetch(withOrg(`/skills/${encodeURIComponent(id)}/export`, { format: 'zip' }), { headers })
      if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.message || `${response.status}`) }
      return response.blob()
    },
    exportSkill: (id: string) => call<{ filename: string; markdown: string }>('GET', `/skills/${id}/export`),
    setSkillAccess: (id: string, visibility: 'workspace' | 'private', version: number) => call('PUT', `/skills/${id}/access`, { visibility, version }),
    createSkill: (s: { files?: SkillFile[]; name: string; description?: string; body: string; metadata?: Record<string, unknown>; visibility?: 'workspace' | 'private' }) => call<{ skill: Skill }>('POST', '/skills', s),
    updateSkill: (id: string, s: Partial<Skill>) => call<{ skill: Skill }>('PUT', `/skills/${id}`, s as Record<string, unknown>),
    deleteSkill: (id: string) => call<{ deleted: boolean }>('DELETE', `/skills/${id}`),

    agentMembers: (agentId: string) => call<AgentRoleState>('GET', `/hx/agents/${agentId}/members`),
    transferAgentOwnership: (agentId:string,ref:string,expectedVersion:number)=>call<{version:number}>('PUT',`/hx/agents/${agentId}/ownership`,{ref,expectedVersion}),
    setAgentMember: (agentId: string, ref: string, role: 'admin' | 'member' | 'none', expectedVersion: number) => call<{version:number}>('PUT', `/hx/agents/${agentId}/members`, {ref,role,expectedVersion}),
    profile: (agentId: string) => call<{ profile: AgentProfile; canEdit: boolean }>('GET', `/hx/agents/${agentId}/profile`),
    saveProfile: (agentId: string, p: Partial<AgentProfile> & { name?: string; emoji?: string }) => call<{ profile: AgentProfile; identity?: { name: string; emoji: string | null } }>('PUT', `/hx/agents/${agentId}/profile`, p as Record<string, unknown>),
    memoryScopes: (agentId: string) => call<{ scopes: Array<{ channel: string; label: string }> }>('GET', `/hx/agents/${agentId}/memory/scopes`),
    memoryReviewLog: (agentId: string, channel = '', cursor?: string) => call<{ reviews: MemoryReview[]; nextCursor: string | null }>('GET', `/hx/agents/${agentId}/memory/reviews`, undefined, { channel, ...(cursor ? { cursor } : {}) }),
    memoryReviews: (agentId: string, memoryId: string, channel = '', cursor?: string) => call<{ reviews: MemoryReview[]; nextCursor: string | null }>('GET', `/hx/agents/${agentId}/memory/${encodeURIComponent(memoryId)}/reviews`, undefined, { channel, ...(cursor ? { cursor } : {}) }),
    reviewMemory: (agentId: string, memory: AgentMemory, evidence: string, channel = '', entry?: MemoryEntryInput, remove = false) => call<{ deleted?: number; review: Omit<NonNullable<AgentMemory['review']>, 'current'>; memory?: AgentMemory }>('PUT', `/hx/agents/${agentId}/memory/${encodeURIComponent(memory.id)}/review`, { ...entry, expectedVersion: memory.version ?? 0, evidence, channel, verdict: remove ? 'delete' : entry ? 'update' : 'keep' }),
    convertMemory: (agentId: string, memory: AgentMemory, channel: string, keepEntry: boolean, requestId: string) => call<{skill: Skill; keptMemory: boolean; replayed: boolean}>('POST', `/hx/agents/${agentId}/memory/${encodeURIComponent(memory.id)}/to-skill`, {expectedVersion: memory.version ?? 0, channel, keepEntry, requestId}),
    memoryPage: (agentId: string, channel = '', cursor?: string, filters: { query?: string; kind?: string } = {}) => call<{ memories: AgentMemory[]; canEdit: boolean; nextCursor: string | null }>('GET', `/hx/agents/${agentId}/memory`, undefined, { channel, paged: '1', ...filters, ...(cursor ? { cursor } : {}) }),
    memory: (agentId: string, channel = '') => call<{ memories: AgentMemory[]; canEdit: boolean }>('GET', `/hx/agents/${agentId}/memory`, undefined, { channel }),
    remember: (agentId: string, text: string, channel = '', kind: MemoryKind = 'context') => call<{ memory: AgentMemory }>('POST', `/hx/agents/${agentId}/memory`, { text, channel, kind }),
    rememberEntry: (agentId: string, entry: MemoryEntryInput, channel = '') => call<{ memory: AgentMemory }>('POST', `/hx/agents/${agentId}/memory`, { ...entry, channel }),
    updateMemory: (agentId: string, memory: AgentMemory, entry: MemoryEntryInput, channel = '') => call<{ memory: AgentMemory }>('PUT', `/hx/agents/${agentId}/memory`, { ...entry, id: memory.id, expectedVersion: memory.version ?? 0, channel }),
    forget: (agentId: string, id: string, channel = '') => call<{ deleted: number }>('DELETE', `/hx/agents/${agentId}/memory`, undefined, { id, channel }),
    agentSkills: (agentId: string) => call<{ skills: Skill[] }>('GET', `/hx/agents/${agentId}/skills`),
    giveSkill: (agentId: string, skillId: string) => call<{ given: boolean }>('POST', `/hx/agents/${agentId}/skills`, { skillId }),
    takeSkill: (agentId: string, skillId: string) => call<{ taken: boolean }>('DELETE', `/hx/agents/${agentId}/skills`, undefined, { skillId }),
  }
}

export type HarnessApi = ReturnType<typeof harnessApi>

/// A mode asked for from outside the page — the desktop app's menu. It is
/// left here when the hub is about to open, or sent as this event when the
/// hub is already open; the hub applies it once it knows who may.
export const WANT_MODE_KEY = 'hx.wantMode'
export const SET_MODE_EVENT = 'honmaru:set-mode'
export const isMode = (m: unknown): m is WorkspaceMode => m === 'simple' || m === 'harness'

/// Simple until this workspace answers. Browser preference changes only
/// presentation; it never writes the workspace's shared configuration.
export function useWorkspaceMode(httpBase: string, orgId: string, sessionToken: string) {
  // Keep authorization results tied to their exact request scope. A workspace
  // switch must not show the previous workspace's mode or admin controls.
  const scope = JSON.stringify([httpBase, orgId, sessionToken])
  const preferenceKey = `hx.simple.${httpBase}.${orgId}`
  const readPreference = () => { try { return localStorage.getItem(preferenceKey) === 'true' } catch { return false } }
  const [snapshot, setSnapshot] = useState({ scope: '', mode: 'simple' as WorkspaceMode, canEdit: false, loaded: false })
  const [preference, setPreference] = useState({ key: preferenceKey, simple: readPreference() })
  const simpleOnly = preference.key === preferenceKey ? preference.simple : readPreference()
  const current = snapshot.scope === scope ? snapshot : { mode: 'simple' as WorkspaceMode, canEdit: false, loaded: false }
  useEffect(() => {
    let live = true
    setSnapshot({ scope, mode: 'simple', canEdit: false, loaded: false })
    if (!orgId || !sessionToken) return
    harnessApi(httpBase, orgId, sessionToken).getMode()
      .then(d => { if (live && isMode(d.mode)) setSnapshot({ scope, mode: d.mode, canEdit: d.canEdit === true, loaded: true }) })
      .catch(() => { /* Default to Simple without inheriting earlier grants. */ })
    const onChange = (e: Event) => {
      const next = (e as CustomEvent<{ orgId: string; httpBase: string; mode: WorkspaceMode }>).detail
      if (next?.orgId === orgId && next.httpBase === httpBase && isMode(next.mode)) {
        setSnapshot(s => s.scope === scope ? { ...s, mode: next.mode } : s)
      }
    }
    window.addEventListener('hx-mode', onChange)
    return () => { live = false; window.removeEventListener('hx-mode', onChange) }
  }, [httpBase, orgId, sessionToken, scope])
  useEffect(() => {
    const update = (event?: Event) => {
      const detail = event?.type === 'hx-simple' ? (event as CustomEvent<{ key: string; simple: boolean }>).detail : null
      if (detail && detail.key !== preferenceKey) return
      setPreference({ key: preferenceKey, simple: detail ? detail.simple : readPreference() })
    }
    update()
    window.addEventListener('hx-simple', update)
    window.addEventListener('storage', update)
    return () => { window.removeEventListener('hx-simple', update); window.removeEventListener('storage', update) }
  }, [preferenceKey])
  const setSimpleOnly = useCallback((simple: boolean) => {
    try { localStorage.setItem(preferenceKey, String(simple)) } catch { /* Current browser session still works. */ }
    setPreference({ key: preferenceKey, simple })
    window.dispatchEvent(new CustomEvent('hx-simple', { detail: { key: preferenceKey, simple } }))
  }, [preferenceKey])
  const setMode = useCallback(async (next: WorkspaceMode) => {
    const d = await harnessApi(httpBase, orgId, sessionToken).setMode(next)
    if (!isMode(d.mode)) throw new Error('Invalid workspace mode.')
    setSnapshot(s => s.scope === scope ? { ...s, mode: d.mode } : s)
    window.dispatchEvent(new CustomEvent('hx-mode', { detail: { orgId, httpBase, mode: d.mode } }))
    return d.mode
  }, [httpBase, orgId, sessionToken, scope])
  return { mode: simpleOnly ? 'simple' as const : current.mode, workspaceMode: current.mode,
    canEdit: current.canEdit, loaded: current.loaded, setMode, simpleOnly, setSimpleOnly }
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
