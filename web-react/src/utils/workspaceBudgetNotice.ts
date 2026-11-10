type BudgetPeriod = {
  limitMicros?: number
  exhausted?: boolean
  indeterminate?: boolean
}

/** Dismissal is local to one signed-in workspace and one saved budget revision. */
export function workspaceBudgetNoticeDismissalKey(scope: string, revision: number): string {
  return JSON.stringify([scope, revision])
}

/** Reject late fetches after another request, workspace, login, or mode wins. */
export function isWorkspaceBudgetNoticeContextCurrent(input: {
  request: number
  latestRequest: number
  expectedScope: string
  currentScope: string
  workspaceMode: string
  simpleOnly: boolean
  workspaceModeLoaded: boolean
}): boolean {
  return input.request === input.latestRequest
    && input.expectedScope === input.currentScope
    && input.workspaceMode === 'harness'
    && !input.simpleOnly
    && input.workspaceModeLoaded
}

/** Whether a workspace's durable AI budget status warrants the Harness notice. */
export function shouldRestoreWorkspaceBudgetNotice(input: {
  workspaceMode?: string
  simpleOnly?: boolean
  canEdit?: boolean
  aiBudget?: { action?: string; periods?: Record<string, BudgetPeriod> } | null
}): boolean {
  if (input.workspaceMode !== 'harness' || input.simpleOnly || !input.canEdit) return false
  const budget = input.aiBudget
  if (budget?.action !== 'pause' || !budget.periods) return false
  return Object.values(budget.periods).some((period) => Number(period?.limitMicros) > 0
    && (period.exhausted === true || period.indeterminate === true))
}
