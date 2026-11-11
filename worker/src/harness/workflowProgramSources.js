// Workflow programs can read only entities explicitly bound on their saved
// definition. Legacy single-source fields remain readable for old workflows.
export function workflowProgramSources(step) {
  if (!step || typeof step !== 'object') return [];
  if (Array.isArray(step.sourceTables)) return step.sourceTables.map(source => ({
    entityId: source?.entityId,
    tableId: source?.tableId,
  }));
  if (typeof step.sourceEntityId === 'string' && typeof step.sourceTableId === 'string') {
    return [{ entityId: step.sourceEntityId, tableId: step.sourceTableId }];
  }
  return [];
}
