// Workflow programs can read only entities explicitly bound on their saved
// definition. Legacy single-source fields remain readable for old workflows.
export function workflowProgramSources(step) {
  if (!step || typeof step !== 'object') return [];
  if (Array.isArray(step.sourceTables)) return step.sourceTables.map(source => ({
    appId: source?.appId || step.sourceAppId,
    entityId: source?.entityId,
    tableId: source?.tableId,
    write: source?.write === true,
    mutate: source?.mutate === true,
  }));
  if (typeof step.sourceEntityId === 'string' && typeof step.sourceTableId === 'string') {
    return [{ appId: step.sourceAppId, entityId: step.sourceEntityId, tableId: step.sourceTableId }];
  }
  return [];
}
