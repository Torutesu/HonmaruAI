const MEMBER_FIELD = /^(担当者|担当メンバー|責任者|所有者|オーナー|レビュー担当|レビュアー|承認者|面接官|owner|assignee|assigned to|reviewer|interviewer|approver)$/iu;
const FREE_TEXT = '(?:自由(?:記述|入力)|free[\\s-]*(?:form[\\s-]*)?text|plain text)';

function explicitlyFreeText(prompt, name) {
  const label = String(name || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!label) return false;
  // Keep the qualifier in the same clause as its field. A free-text Notes
  // field must not accidentally turn a separate assignee into plain text.
  const near = '[^\\n、。；;，,]{0,40}';
  return new RegExp(`(?:${label}${near}${FREE_TEXT}|${FREE_TEXT}${near}${label})`, 'iu').test(String(prompt || ''));
}

export function normalizeMemberFields(prompt, columns) {
  if (!Array.isArray(columns)) return columns;
  return columns.map(column => {
    if (!column || typeof column !== 'object' || !MEMBER_FIELD.test(String(column.name || '').trim())) return column;
    const { options: _options, ...rest } = column;
    if (explicitlyFreeText(prompt, column.name)) return column.type === 'person' ? { ...rest, type: 'text' } : column;
    return { ...rest, type: 'person' };
  });
}
