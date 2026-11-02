import {workspaceFileApi} from './workspaceFiles'
import {appDrafts} from './appDrafts'
export interface SkillFile { path: string; base64: string; size?: number }
export type SkillDraft = Pick<Skill, 'name' | 'description' | 'body' | 'metadata'> & { files?: SkillFile[] }
export type SkillImportInput = string | { zipBase64: string } | { files: SkillFile[] }
export interface AppMessage { id:number; authorId:string; authorName:string; body:string; createdAt:string }
export interface AppAnnotationMeta { target:string; x:number; y:number; section:'overview'|'data' }
export interface AppAnnotation extends AppAnnotationMeta { id:string; tableId:string; rowId:string; messageSource:'app'|'channel'; messageId:string; authorId:string; authorName:string; body:string; createdAt:string }
export interface AppConversation { threadId:string; messages:AppMessage[]; hasMore:boolean; annotations?:AppAnnotation[]; source?:{channel:string;threadId:string;messages:Array<{id:string;body:string;authorName?:string;kind?:string;createdAt:string}>}|null; aiReplies?:Array<{messageId:number;status:string;error?:string}> }
export interface PersonalViews { snapshot?: {app:App;table:Table;rows:Row[];views:View[];canCustomize:boolean}; activeView?: string; appVersion?:number; revision: number; views: View[]; computed: View[]; layouts: Record<string, {order:string[];widths:Record<string,number>;hidden?:string[];wrapText?:boolean}> }
import { useCallback, useEffect, useRef, useState } from 'react'

// The harness (docs/kylon-gap-plan.md), as the web app talks to it: the
// workspace's mode, and the Apps, Tables, Workflows, Follow-ups, Approvals,
// Skills and agent profiles under it. A workspace in "simple" mode shows
// none of it — the feed and the chat, as Honmaru always was.

export type WorkspaceMode = 'simple' | 'harness'

export class HarnessApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message) }
}

export type ColumnType = 'text' | 'number' | 'date' | 'select' | 'checkbox' | 'url' | 'person' | 'email' | 'relation'
export interface Column { id: string; name: string; type: ColumnType; options?: string[]; targetEntity?: string; multiple?: boolean }
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
export interface MigrationPreview { previewChecksum: string; canApply: boolean; changes: Array<{entity:string;tableName:string;operations:string[];schemaChanges:Array<Record<string,unknown>>;rowsScanned:number;rowsChanged:number;examples:Array<{id:string;before:Record<string,unknown>;after:Record<string,unknown>;relationMatches?:Array<{column:string;targetEntity:string;matches:Array<{label:string;recordId:string;matchBy:string}>}>}>;blockers:unknown[]}>; blockers:Array<{entity:string;id:string;column?:string;reason:string}>; blockerCount:number }
export interface AppDatabase { version: number; entities: AppEntity[]; migrations: Array<{id:string;version:number;checksum:string;plan:unknown;createdAt:string}>; fork: AppFork | null }
export interface Template { id: string; name: string; icon: string; description: string }
export interface TemplateShare { id: string; appVersion: number; createdAt: string; expiresAt: string; revokedAt: string | null }
export interface SharedTemplate { format: 1; app: { name: string; description: string; icon: string }; version: number; tableName: string; columns: Array<{ name: string; type: Column['type']; options?: string[] }>; definition: { views: View[] } }

export type TriggerType = 'manual' | 'schedule' | 'webhook' | 'row' | 'app_record_change'
export interface Trigger {
  type: TriggerType
  tableId?: string; on?: 'added' | 'changed' | 'deleted' | 'any'; where?: Record<string, string[]>; column?: string
  appId?: string; entityId?: string; events?: Array<'insert'|'update'|'delete'>; when?: {where:Record<string,ConditionScalar|ConditionScalar[]>}
  kind?: 'cron' | 'every' | 'at'; expr?: string; everyMs?: number; at?: string
  cadence?: string; hour?: number; minute?: number; weekday?: number; monthday?: number; timezone?: string
}
export type StepType = 'post' | 'agent' | 'add_row' | 'update_row' | 'approval' | 'followup' | 'code'
export type ConditionScalar = string | number | boolean | null
export type WorkflowCondition = {all:WorkflowCondition[]} | {any:WorkflowCondition[]} | {not:WorkflowCondition} | {path:string[];op:'eq'|'neq'|'gt'|'gte'|'lt'|'lte'|'contains'|'in'|'exists';value:ConditionScalar|ConditionScalar[]}
export interface Step {
  code?: string; gatewayId?: string
  when?: WorkflowCondition
  type: StepType
  channel?: string; text?: string; agentId?: string; prompt?: string; tableId?: string; rowId?: string
  values?: Record<string, unknown>; to?: string; title?: string; summary?: string; minutes?: number
}
export interface WorkflowSourceState {source:{threadId:string;channel:string;body:string;createdAt:string}|null;canBind:boolean;candidates:Array<{id:string;channel:string;body:string;createdAt:string}>;nextCursor:number|null}
export interface WorkflowNotice { workflowId: string; generation: string; runId: string; createdAt: string; readAt: string|null; name: string; paused: boolean }
export interface WorkflowBudgetPeriod { limit: number; used: number; resetAt: string; exhausted: boolean }
export interface WorkflowAiBudgetPeriod { limitUsd:number; usedUsd:number; unpricedCalls:number; resetAt:string|null; exhausted:boolean }
export interface WorkflowAiBudget { revision:number; action:'warn'|'pause'; '24h':WorkflowAiBudgetPeriod; '7d':WorkflowAiBudgetPeriod; '30d':WorkflowAiBudgetPeriod }
export interface WorkflowBudget { revision: number; daily: WorkflowBudgetPeriod; weekly: WorkflowBudgetPeriod; monthly: WorkflowBudgetPeriod; ai:WorkflowAiBudget }
export interface WorkflowSafety { generation: string; failure_streak: number; paused_at: string | null; pause_reason: string | null; daily_run_limit?: number; weekly_run_limit?: number; monthly_run_limit?: number; daily_ai_budget_micros?:number; weekly_ai_budget_micros?:number; monthly_ai_budget_micros?:number; ai_budget_action?:'warn'|'pause'; budget_revision?: number; budget?: WorkflowBudget | null }
export interface Workflow {
  updatedAt?: string
  safety?: WorkflowSafety | null
  sourceChannel?: string
  id: string; name: string; enabled: boolean; trigger: Trigger; steps: Step[]
  nextRunAt: string | null; lastRunAt: string | null; createdBy: string; hookUrl?: string; hookSecret?: string; webhookSignatureRequired?: boolean
}
export interface WorkflowRevision {revision:number;recordedAt:string;definition:Pick<Workflow,'name'|'enabled'|'trigger'|'steps'> & {createdBy:string}}
export interface WorkflowRevisionRestore {workflow:Workflow;restoredRevision:number;revision:number|null;safetyPaused:boolean}
export type AutomationDefinition = Pick<Workflow, 'name' | 'enabled' | 'trigger' | 'steps'>
export interface AutomationBundle { version: 1; items: Array<AutomationDefinition & {key: string}> }
export interface AutomationPlanItem { key: string; workflowId: string | null; status: 'added'|'changed'|'unchanged'|'removed'|'retired'|'drifted'|'missing'; declared: AutomationDefinition | null; published: AutomationDefinition | null; live: AutomationDefinition | null }
export interface AppAutomationState { version: number; revision: number; draft: AutomationBundle; published: AutomationBundle | null; releaseId: string | null; publishedAt: string | null; plan?: AutomationPlanItem[] }
export interface RunLog { step: number; type: StepType; status: string; output?: string; error?: string; at: string }
export interface HeldWorkflowEvents { count: number; oldestExpiry: string | null; events: Array<{ id: string; receivedAt: string; expiresAt: string }>; discardEventIds?: string[] }
export interface RunUsageCounters { calls:number; inputTokens:number; outputTokens:number; unknownCalls:number; unpricedCalls:number; estimatedMicros:number }
export interface RunUsage extends RunUsageCounters { coverage:'priced-token-estimate'; estimatedUsd:number; steps:Array<RunUsageCounters & {stepNumber:number}> }
export interface Run { definitionRevision?:number|null; definitionSnapshotAvailable?:boolean; usage?:RunUsage; id: string; trigger: string; status: string; log: RunLog[]; startedAt: string; finishedAt: string | null; cardId: string | null }
export interface Followup { id: string; threadId?: string | null; channel: string; instruction: string; dueAt: string; status: string; agentId: string | null; result?: string | null; doneAt?: string | null }
export interface Gateway { id: string; name: string; createdAt: number; lastSeenAt: number | null; revokedAt: number | null; acpAgents?: string[] }
export interface GatewayJob { id: string; gatewayId: string; status: string; createdAt: number; result: { stdout?: string; stderr?: string; error?: string; exitCode?: number | null } | null }
export interface Skill { sourceScope?: { agentId: string; channel: string | null } | null; createdByName?: string; metadata?: Record<string, unknown>; visibility?: 'workspace' | 'private'; accessVersion?: number; canShare?: boolean; canEdit?: boolean; id: string; name: string; description: string; body: string; agents?: string[]; createdBy: string }
export interface SkillShareLink { id: string; createdAt: string; expiresAt: string; revokedAt: string | null; fileCount: number; totalBytes: number }
export interface SharedSkillInfo { name: string; description: string; metadata: Record<string, unknown>; fileCount: number; totalBytes: number; expiresAt: string }
export interface AgentRoleState { version: number; scope: 'team' | 'personal'; canManage: boolean; canAddMembers?: boolean; members: Array<{ref: string; name: string; role: 'admin' | 'member'; owner: boolean; mine?: boolean}>; candidates: Array<{ref: string; name: string}> }
export interface AgentProfile { specialty: string; tier: 'lite' | 'standard' | 'max'; mentionOnly: boolean; access: 'everyone' | 'people' | 'private'; people: string[] }
export interface AgentAppConnection { server: string; name: string; description: string; iconUrl: string | null; verified: boolean; allowWrites: boolean; connectedAt: string; granted: boolean }
export interface AgentNativeConnection { source: 'notion' | 'github'; available: boolean; enabled: boolean }
export interface AgentRemoteMcpConnection { serverId: string; name: string; available: boolean; enabled: boolean; readOnlyToolCount: number; needsOAuth?: boolean }
export interface AgentConnectionState { connections: AgentAppConnection[]; nativeConnections: AgentNativeConnection[]; remoteMcpConnections?: AgentRemoteMcpConnection[] }
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
  async function call<T>(method: string, path: string, body?: Record<string, unknown>, query?: Record<string, string>, signal?: AbortSignal): Promise<T> {
    const read = method === 'GET' || method === 'DELETE'
    const res = await fetch(read ? withOrg(path, query) : `${httpBase}${path}`, {
      method, headers, signal, body: read ? undefined : JSON.stringify({ orgId, ...(body || {}) }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new HarnessApiError(data.message || `${res.status}`, res.status, typeof data.code === 'string' ? data.code : undefined)
    return data as T
  }
  return {
    httpBase, orgId, drafts: appDrafts(httpBase,orgId,sessionToken), files: workspaceFileApi(httpBase,orgId,sessionToken),
    conversation: (id:string, scope:{tableId?:string;rowId?:string}={}, before?:number) => call<AppConversation>('GET',`/apps/${id}/conversation`,undefined,{...(scope.tableId?{tableId:scope.tableId}:{}),...(scope.rowId?{rowId:scope.rowId}:{}),...(before?{before:String(before)}:{})}),
    postConversation: (id:string, scope:{tableId?:string;rowId?:string}, body:string, requestId:string, annotation?:AppAnnotationMeta) => call<{threadId:string;messageId:number;annotationId?:string}>('POST',`/apps/${id}/conversation`,{...scope,body,requestId,...(annotation?{annotation}:{})}),
    markSourceRead: (channel:string,thread:string,at:string) => call('POST','/channels/read',{channel,thread,at}),
    conversationSources: (id:string) => call<{candidates:Array<{id:string;body:string;channel:string;createdAt:string}>}>('GET',`/apps/${id}/conversation-source`),
    inheritConversation: (id:string,messageId:string) => call('POST',`/apps/${id}/conversation-source`,{messageId}),
    conversationNotifications: (id:string) => call<{items:Array<{messageId:number;body:string;tableId:string;rowId:string;readAt:string|null;kind:string}>}>('GET',`/apps/${id}/conversation-notifications`),
    readConversationNotification: (id:string,messageId:number) => call('POST',`/apps/${id}/conversation-notifications`,{messageId}),
    members: () => call<{members:Array<{ref:string;name:string;avatarUrl?:string|null}>}>('GET','/members'),
    personalViews: (id:string) => call<PersonalViews>('GET', `/hx/personal-views/${id}`),
    savePersonalViews: (id:string, state:PersonalViews) => call<PersonalViews>('PUT', `/hx/personal-views/${id}`, {expectedRevision:state.revision,views:state.views,layouts:state.layouts,activeView:state.activeView}),
    appPins: () => call<{pins:string[]}>('GET', '/hx/app-pins'),
    setAppPin: (appId:string,pinned:boolean) => call<{pins:string[]}>('PUT','/hx/app-pins',{appId,pinned}),
    gateways: () => call<{ gateways: Gateway[]; canManage: boolean }>('GET', '/gateways'),
    registerGateway: (name: string) => call<{ gateway: Gateway; token: string }>('POST', '/gateways', { name }),
    revokeGateway: (id: string) => call('POST', `/gateways/${encodeURIComponent(id)}/revoke`),
    gatewayJobs: () => call<{ jobs: GatewayJob[] }>('GET', '/gateways/jobs'),
    execute: (gatewayId: string, code: string, input: unknown, requestId: string, language?:'javascript'|'typescript') => call<{ job: GatewayJob }>('POST', '/gateways/jobs', { gatewayId, code, input, requestId,...(language==='typescript'?{language}:{}) }),
    cancelExecution: (id: string) => call('POST', `/gateways/jobs/${encodeURIComponent(id)}/cancel`),
    home: () => call<HomeData>('GET', '/harness/home'),
    getMode: (signal?:AbortSignal) => call<{ mode: WorkspaceMode; canEdit: boolean; simpleOnly?: boolean; revision?: number }>('GET', '/orgs/mode',undefined,undefined,signal),
    setMode: (mode: WorkspaceMode) => call<{ mode: WorkspaceMode; canEdit: boolean }>('PUT', '/orgs/mode', { mode }),
    setDisplayPreference: (simpleOnly: boolean) => call<{ simpleOnly: boolean; revision: number }>('PUT', '/hx/display-preference', { simpleOnly }),

    templates: () => call<{ templates: Template[] }>('GET', '/apps/templates'),
    templateShares: (id: string) => call<{ shares: TemplateShare[]; canManage: boolean }>('GET', `/apps/${id}/template-shares`),
    createTemplateShare: (id: string, version: number, expiresInDays: number) => call<{ share: TemplateShare; token: string }>('POST', `/apps/${id}/template-shares`, { version, expiresInDays }),
    revokeTemplateShare: (id: string, shareId: string) => call<{ revoked: boolean }>('POST', `/apps/${id}/template-shares/${encodeURIComponent(shareId)}/revoke`, {}),
    sharedTemplate: (token: string, signal?: AbortSignal) => call<{ snapshot: SharedTemplate; expiresAt: string }>('GET', `/template-shares/${encodeURIComponent(token)}`, undefined, undefined, signal),
    importSharedTemplate: (token: string, name?: string) => call<{ app: App; sourceVersion: number; expiresAt: string }>('POST', `/template-shares/${encodeURIComponent(token)}/import`, name ? { name } : {}),
    apps: (channel?: string) => call<{ apps: App[] }>('GET', '/apps', undefined, channel ? { channel } : {}),
    app: (id: string) => call<{ app: App; table: Table; rows: Row[]; views: View[]; canCustomize: boolean }>('GET', `/apps/${id}`),
    createFromTemplate: (template: string, channel?: string) => call<{ app: App }>('POST', '/apps', { template, channel }),
    // Never fall back to the older route: an older Worker ignores sampleCount.
    generate: (prompt: string, channel?: string, generation?: {requestId:string;captureSource?:boolean;sourceThreadId?:string;sampleCount?:number}) => call<{ app: App; source: 'model' | 'template'; room: string | null }>('POST', '/app-generation-v2', { prompt, channel, ...generation }).catch(error => {
      if (error instanceof HarnessApiError && error.status === 404 && error.message === '404') throw new HarnessApiError('App generation requires a newer service. Please try again after the service is updated.', 404)
      throw error
    }),
    updateApp: (id: string, patch: Record<string, unknown>) => call<{ app: App }>('PUT', `/apps/${id}`, patch),
    generateCustom: (id: string, prompt: string) => call<{ html: string }>('POST', `/apps/${id}/custom`, { action: 'generate', prompt }),
    saveCustom: (id: string, action: 'draft' | 'publish' | 'unpublish' | 'restore', version: number, html?: string, restoreVersion?: number) => call('POST', `/apps/${id}/custom`, { action, version, html, restoreVersion }),
    generateAppAutomation: (id: string, prompt: string, timezone: string) => call<{automation:AutomationBundle['items'][number]}>('POST', `/apps/${id}/automations`, {action:'generate',prompt,timezone}),
    appAutomations: (id: string, stateOnly = false) => call<AppAutomationState>('GET', `/apps/${id}/automations`, undefined, stateOnly ? {stateOnly:'1'} : {}),
    saveAppAutomations: (id: string, version: number, revision: number, automations: AutomationBundle) => call<{saved:boolean;revision:number}>('PUT', `/apps/${id}/automations`, {version,revision,automations}),
    releaseAppAutomations: (id: string, body: Record<string,unknown>) => call<{saved:boolean;revision:number;version:number;replay?:boolean}>('POST', `/apps/${id}/automations`, body),
    appDatabase: (id: string) => call<AppDatabase>('GET', `/apps/${id}/database`),
    previewDatabaseMigration: (id: string, body: Record<string, unknown>) => call<MigrationPreview>('POST', `/apps/${id}/database`, body),
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

    workflowAgents: () => call<{agents:Array<{id:string;handle:string;name:string;emoji?:string|null}>}>('GET', '/channels/agents'),
    tables: () => call<{ tables: Table[] }>('GET', '/tables'),
    addRow: (tableId: string, values: Record<string, unknown>, validation?: 'strict') => call<{ row: Row }>('POST', `/tables/${tableId}/rows`, { values, validation }),
    updateRow: (tableId: string, rowId: string, values: Record<string, unknown>, expectedUpdatedAt?: string, validation?: 'strict') => call<{ row: Row }>('PATCH', `/tables/${tableId}/rows/${rowId}`, { values, expectedUpdatedAt, validation }),
    deleteRow: (tableId: string, rowId: string, expectedUpdatedAt?: string) => call<{ deleted: boolean }>('DELETE', `/tables/${tableId}/rows/${rowId}`, undefined, expectedUpdatedAt ? { expectedUpdatedAt } : {}),

    workflowRevisions: (id:string,before?:number) => call<{items:WorkflowRevision[];nextCursor:number|null}>('GET', `/workflows/${id}/revisions`,undefined,before===undefined?{}:{before:String(before)}),
    restoreWorkflowRevision: (id:string,input:{revision:number;expectedUpdatedAt:string;confirmAutoPaused?:boolean}) => call<WorkflowRevisionRestore>('POST',`/workflows/${id}/rollback`,input),
    workflows: () => call<{ workflows: Workflow[] }>('GET', '/workflows'),
    workflow: (id: string) => call<{ workflow: Workflow; runs: Run[]; canEdit: boolean; held?: HeldWorkflowEvents }>('GET', `/workflows/${id}`),
    generateWorkflow: (prompt: string, channel?: string, options?: {requestId: string; captureSource?: boolean}) => call<{ workflow: Workflow; source: string }>('POST', '/workflows/generate', { prompt, channel, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, ...options }),
    createWorkflow: (w: { name: string; trigger: Trigger; steps: Step[] }) => call<{ workflow: Workflow; hookUrl?: string }>('POST', '/workflows', w as unknown as Record<string, unknown>),
    updateWorkflow: (id: string, patch: Record<string, unknown>) => call<{ workflow: Workflow }>('PUT', `/workflows/${id}`, patch),
    updateWorkflowBudget: (id:string,budget:{revision:number;dailyLimit:number;weeklyLimit:number;monthlyLimit:number;dailyAiLimitUsd:number;weeklyAiLimitUsd:number;monthlyAiLimitUsd:number;aiBudgetAction:'warn'|'pause'}) => call<{budget:WorkflowBudget;safety:WorkflowSafety}>('PUT',`/workflows/${id}/budget`,budget),
    changeWorkflowHook: (id: string, action: 'rotate' | 'revoke', expectedSecret: string | null) => call<{ workflow: Workflow }>('POST', `/workflows/${id}/webhook`, { action, expectedSecret }),
    replayWorkflowEvents: (id: string, eventIds: string[]) => call<{ runs: Array<{ eventId: string; runId: string; status: string }>; skipped: number }>('POST', `/workflows/${id}/webhook/replay`, { eventIds }),
    heldWorkflowEvent: (id: string, eventId: string) => call<{ event: { id: string; receivedAt: string; expiresAt: string; input: unknown } }>('GET', `/workflows/${id}/webhook/events/${encodeURIComponent(eventId)}`),
    discardWorkflowEvents: (id: string, eventIds: string[]) => call<{ discarded: number }>('POST', `/workflows/${id}/webhook/discard`, { eventIds }),
    deleteWorkflow: (id: string) => call<{ deleted: boolean }>('DELETE', `/workflows/${id}`),
    workflowSource: (id:string,before?:number) => call<WorkflowSourceState>('GET',`/workflows/${id}/source`,undefined,{candidates:'1',...(before?{before:String(before)}:{})}),
    bindWorkflowSource: (id:string,messageId:string) => call<WorkflowSourceState>('POST',`/workflows/${id}/source`,{messageId}),
    workflowNotices: () => call<{ items: WorkflowNotice[] }>('GET', '/workflows/notices'),
    readWorkflowNotice: (workflowId: string, generation: string) => call<{ ok: boolean }>('POST', '/workflows/notices', { workflowId, generation }),
    resumeWorkflow: (id: string, generation: string) => call<{ safety: WorkflowSafety }>('POST', `/workflows/${id}/resume`, { generation }),
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
    skillShares: (id: string) => call<{ shares: SkillShareLink[] }>('GET', `/skills/${encodeURIComponent(id)}/shares`),
    createSkillShare: (id: string, expiresInDays: number) => call<{ token: string; share: SkillShareLink }>('POST', `/skills/${encodeURIComponent(id)}/shares`, { expiresInDays, confirmAnyoneWithLink: true }),
    revokeSkillShare: (id: string, shareId: string) => call<{ revoked: boolean }>('POST', `/skills/${encodeURIComponent(id)}/shares/${encodeURIComponent(shareId)}/revoke`),
    sharedSkill: (token: string, signal?: AbortSignal) => call<{ share: SharedSkillInfo }>('GET', `/skill-shares/${encodeURIComponent(token)}`, undefined, undefined, signal),
    skillShareImportAgents: (token: string) => call<{ agents: Array<{id:string;name:string}> }>('GET', `/skill-shares/${encodeURIComponent(token)}/import-agents`),
    importSkillShare: (token: string, name?: string, agentId?: string) => call<{skill:Skill;installedOnAgent:boolean}>('POST', `/skill-shares/${encodeURIComponent(token)}/import`, { ...(name?.trim()?{name:name.trim()}:{}), ...(agentId?{agentId}:{}) }),
    updateSkill: (id: string, s: Partial<Skill>) => call<{ skill: Skill }>('PUT', `/skills/${id}`, s as Record<string, unknown>),
    deleteSkill: (id: string) => call<{ deleted: boolean }>('DELETE', `/skills/${id}`),

    agentMembers: (agentId: string) => call<AgentRoleState>('GET', `/hx/agents/${agentId}/members`),
    agentApps: (agentId: string) => call<AgentConnectionState>('GET', `/hx/agents/${agentId}/apps`),
    setAgentApp: (agentId: string, server: string, granted: boolean) => call<AgentConnectionState>(granted ? 'POST' : 'DELETE', `/hx/agents/${agentId}/apps`, granted ? { server } : undefined, granted ? undefined : { server }),
    setAgentNativeSource: (agentId: string, source: AgentNativeConnection['source'], granted: boolean) => call<AgentConnectionState>(granted ? 'POST' : 'DELETE', `/hx/agents/${agentId}/apps`, granted ? { source } : undefined, granted ? undefined : { source }),
    setAgentRemoteMcpConnection: (agentId: string, serverId: string, granted: boolean) => call<AgentConnectionState>(granted ? 'POST' : 'DELETE', `/hx/agents/${agentId}/apps`, granted ? { remoteMcpServerId: serverId } : undefined, granted ? undefined : { remoteMcpServerId: serverId }),
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
// A short, non-cryptographic namespace for local presentation caches. Never
// place a session token itself in a storage key; server preferences are keyed
// by the authenticated account and are what synchronizes separate devices.
function localSessionScope(token:string){let a=2166136261,b=0x9e3779b9;for(let i=0;i<token.length;i++){const c=token.charCodeAt(i);a=Math.imul(a^c,16777619);b=Math.imul(b^c,2246822519)}return `${(a>>>0).toString(36)}${(b>>>0).toString(36)}`}

/// Simple until this workspace answers. Browser preference changes only
/// presentation; it never writes the workspace's shared configuration.
export function useWorkspaceMode(httpBase: string, orgId: string, sessionToken: string) {
  // Keep authorization results tied to their exact request scope. A workspace
  // switch must not show the previous workspace's mode or admin controls.
  const scope = JSON.stringify([httpBase, orgId, sessionToken])
  const preferenceKey = `hx.simple.${httpBase}.${orgId}.${localSessionScope(sessionToken)}`
  const pendingPreferenceKey = `hx.simple.pending.${httpBase}.${orgId}.${localSessionScope(sessionToken)}`
  // Only presentation is cached. Never persist session tokens or grants.
  const displayKey = `hx.displayMode.${JSON.stringify([httpBase,orgId])}`
  const [offline,setOffline]=useState(()=>typeof navigator!=='undefined'&&navigator.onLine===false)
  const rememberMode=(mode:WorkspaceMode)=>{try{localStorage.setItem(displayKey,mode)}catch{}}
  const offlineMode=():WorkspaceMode=>{try{const mode=localStorage.getItem(displayKey);return isMode(mode)?mode:'simple'}catch{return 'simple'}}
  useEffect(()=>{const update=()=>setOffline(navigator.onLine===false);window.addEventListener('online',update);window.addEventListener('offline',update);return()=>{window.removeEventListener('online',update);window.removeEventListener('offline',update)}},[])

  const readPreference = () => { try { const value=localStorage.getItem(preferenceKey);if(!value)return false;const parsed=JSON.parse(value);return typeof parsed?.simpleOnly==='boolean'?parsed.simpleOnly:value==='true' } catch { return false } }
  const readPendingPreference = ():boolean|null=>{try{const value=localStorage.getItem(pendingPreferenceKey);return value==='true'?true:value==='false'?false:null}catch{return null}}
  const savePreference = (simple:boolean,revision=0)=>{try{localStorage.setItem(preferenceKey,JSON.stringify({simpleOnly:simple,revision}))}catch{}}
  const savePendingPreference = (simple:boolean|null)=>{try{if(simple===null)localStorage.removeItem(pendingPreferenceKey);else localStorage.setItem(pendingPreferenceKey,String(simple))}catch{}}
  const [snapshot, setSnapshot] = useState({ scope: '', mode: 'simple' as WorkspaceMode, canEdit: false, loaded: false, error:'' })
  const [preference, setPreference] = useState({ key: preferenceKey, simple: readPreference(), revision:0 })
  const preferenceRef=useRef(preference)
  const [preferenceError,setPreferenceError]=useState(false)
  const preferenceWrite=useRef(Promise.resolve())
  const applyPreference=useCallback((simple:boolean,revision?:number)=>{
    const current=preferenceRef.current
    const next={key:preferenceKey,simple,revision:revision??(current.key===preferenceKey?current.revision:0)}
    preferenceRef.current=next;setPreference(next)
  },[preferenceKey])
  const simpleOnly = preference.key === preferenceKey ? preference.simple : readPreference()
  const current = snapshot.scope === scope ? snapshot : { mode: 'simple' as WorkspaceMode, canEdit: false, loaded: false, error:'' }
  const [retryCount,setRetryCount]=useState(0)
  const retry=useCallback(()=>setRetryCount(value=>value+1),[])
  useEffect(() => {
    let live = true
    setSnapshot({ scope, mode: 'simple', canEdit: false, loaded: false, error:'' })
    if (!orgId || !sessionToken) return
    if(offline){setSnapshot({scope,mode:offlineMode(),canEdit:false,loaded:false,error:''});return}
    const controller=new AbortController()
    const fail=()=>{if(live)setSnapshot({scope,mode:'simple',canEdit:false,loaded:false,error:'Workspace settings could not load.'})}
    const timer=setTimeout(()=>{controller.abort();fail()},15000)
    const api=harnessApi(httpBase, orgId, sessionToken)
    api.getMode(controller.signal)
      .then(async d => {
        if (!live||controller.signal.aborted) return
        if(!isMode(d.mode)){fail();return}
        let simple=typeof d.simpleOnly==='boolean'?d.simpleOnly:readPreference()
        let revision=Number.isSafeInteger(d.revision)&&Number(d.revision)>=0?Number(d.revision):0
        // Retry an offline preference when this same signed-in session
        // reconnects. An unscoped legacy key is deliberately not imported:
        // it could belong to somebody else on a shared device.
        const pending=readPendingPreference()
        if(pending!==null){
          const wanted=pending
          try{const saved=await api.setDisplayPreference(wanted);if(!live||controller.signal.aborted)return;simple=saved.simpleOnly;revision=saved.revision;savePendingPreference(null);setPreferenceError(false)}
          catch{simple=wanted;savePendingPreference(wanted);if(live&&!controller.signal.aborted)setPreferenceError(true)}
        }
        savePreference(simple,revision);rememberMode(d.mode);applyPreference(simple,revision)
        setSnapshot({ scope, mode: d.mode, canEdit: d.canEdit === true, loaded: true,error:'' })
      })
      .catch(()=>{if(!controller.signal.aborted)fail()}).finally(()=>clearTimeout(timer))
    const onChange = (e: Event) => {
      const next = (e as CustomEvent<{ orgId: string; httpBase: string; mode: WorkspaceMode }>).detail
      if (next?.orgId === orgId && next.httpBase === httpBase && isMode(next.mode)) {
        rememberMode(next.mode)
        setSnapshot(s => s.scope === scope ? { ...s, mode: next.mode } : s)
      }
    }
    window.addEventListener('hx-mode', onChange)
    return () => { live = false;clearTimeout(timer);controller.abort(); window.removeEventListener('hx-mode', onChange) }
  }, [httpBase, orgId, sessionToken, scope,retryCount,offline,applyPreference])
  useEffect(() => {
    const update = (event?: Event) => {
      const detail = event?.type === 'hx-simple' ? (event as CustomEvent<{ key: string; simple: boolean; revision?:number }>).detail : null
      if (detail && detail.key !== preferenceKey) return
      const current=preferenceRef.current
      if(detail&&Number.isSafeInteger(detail.revision)&&current.key===preferenceKey&&Number(detail.revision)<current.revision)return
      applyPreference(detail ? detail.simple : readPreference(),detail?.revision)
    }
    update()
    window.addEventListener('hx-simple', update)
    window.addEventListener('storage', update)
    return () => { window.removeEventListener('hx-simple', update); window.removeEventListener('storage', update) }
  }, [preferenceKey,applyPreference])
  useEffect(()=>{
    const onRemote=(event:Event)=>{
      const detail=(event as CustomEvent<{orgId:string;simpleOnly:boolean;revision:number}>).detail
      if(detail?.orgId!==orgId||typeof detail.simpleOnly!=='boolean'||!Number.isSafeInteger(detail.revision))return
      const current=preferenceRef.current
      const pending=readPendingPreference()
      if((current.key===preferenceKey&&detail.revision<current.revision)||(pending!==null&&pending!==detail.simpleOnly))return
      savePreference(detail.simpleOnly,detail.revision);savePendingPreference(null);setPreferenceError(false)
      applyPreference(detail.simpleOnly,detail.revision)
      window.dispatchEvent(new CustomEvent('hx-simple',{detail:{key:preferenceKey,simple:detail.simpleOnly,revision:detail.revision}}))
    }
    window.addEventListener('honmaru:display-preference-changed',onRemote)
    return()=>window.removeEventListener('honmaru:display-preference-changed',onRemote)
  },[orgId,preferenceKey,applyPreference])
  const setSimpleOnly = useCallback((simple: boolean) => {
    savePreference(simple,preferenceRef.current.key===preferenceKey?preferenceRef.current.revision:0)
    savePendingPreference(simple)
    applyPreference(simple)
    window.dispatchEvent(new CustomEvent('hx-simple', { detail: { key: preferenceKey, simple } }))
    if(offline)return Promise.resolve({simpleOnly:simple,revision:preferenceRef.current.revision,pending:true})
    const write=preferenceWrite.current.catch(()=>{}).then(async()=>{
      const wanted=readPreference()
      const saved=await harnessApi(httpBase,orgId,sessionToken).setDisplayPreference(wanted)
      if(readPreference()===saved.simpleOnly){savePreference(saved.simpleOnly,saved.revision);savePendingPreference(null);setPreferenceError(false);applyPreference(saved.simpleOnly,saved.revision);window.dispatchEvent(new CustomEvent('hx-simple',{detail:{key:preferenceKey,simple:saved.simpleOnly,revision:saved.revision}}))}
      return saved
    }).catch(error=>{const latest=readPreference();savePendingPreference(latest);setPreferenceError(true);throw error})
    preferenceWrite.current=write.then(()=>undefined,()=>undefined)
    return write
  },[httpBase,orgId,sessionToken,preferenceKey,offline,applyPreference])
  const setMode = useCallback(async (next: WorkspaceMode) => {
    const d = await harnessApi(httpBase, orgId, sessionToken).setMode(next)
    if (!isMode(d.mode)) throw new Error('Invalid workspace mode.')
    rememberMode(d.mode)
    setSnapshot(s => s.scope === scope ? { ...s, mode: d.mode } : s)
    window.dispatchEvent(new CustomEvent('hx-mode', { detail: { orgId, httpBase, mode: d.mode } }))
    return d.mode
  }, [httpBase, orgId, sessionToken, scope])
  return { mode: simpleOnly ? 'simple' as const : current.mode, workspaceMode: current.mode,
    canEdit: !offline&&current.canEdit, loaded: current.loaded,offline,error:current.error,retry, setMode, simpleOnly, setSimpleOnly,preferenceError }
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
