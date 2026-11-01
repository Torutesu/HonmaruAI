const MEMBER_FIELD = /^(担当者|担当メンバー|責任者|所有者|オーナー|レビュー担当|レビュアー|承認者|面接官|owner|assignee|assigned to|reviewer|interviewer|approver)$/iu;
const FREE_TEXT = '(?:自由(?:記述|入力)|free[\\s-]*(?:form[\\s-]*)?text|plain text)';
const MEMBER_PICKER = '(?:ワークスペース[^\\n、。；;，,]{0,20}(?:メンバー|ユーザー)|(?:メンバー|ユーザー)[^\\n、。；;，,]{0,12}(?:選択|選ぶ)|workspace[\\s-]*members?|member[\\s-]*(?:picker|selection)|person[\\s-]*(?:field|reference))';

function explicitlyFreeText(prompt, name) {
  const label = String(name || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!label) return false;
  // Keep the qualifier in the same clause as its field. A free-text Notes
  // field must not accidentally turn a separate assignee into plain text.
  const near = '[^\\n、。；;，,]{0,40}';
  const match = new RegExp(`(?:${label}${near}${FREE_TEXT}|${FREE_TEXT}${near}${label})`, 'iu');
  const negated = new RegExp(`(?:${FREE_TEXT}[^\\n、。；;，,]{0,8}(?:ではなく|ではない|でなく|にしない|しない|使わない|不要|なし|禁止)|\\bnot\\s+${FREE_TEXT})`, 'iu');
  return String(prompt || '').split(/[\n、。；;，,]/u).some(clause => match.test(clause) && !negated.test(clause));
}

function explicitlyMember(prompt, name) {
  const label = String(name || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!label) return false;
  const near = '[^\\n、。；;，,]{0,40}';
  return new RegExp(`(?:${label}${near}${MEMBER_PICKER}|${MEMBER_PICKER}${near}${label})`, 'iu').test(String(prompt || ''));
}

function explicitlyNoMember(prompt, name) {
  const label = String(name || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!label) return false;
  const near = '[^\\n、。；;，,]{0,40}';
  const negative = '(?:(?:メンバー|ユーザー)[^\\n、。；;，,]{0,16}(?:選ばな|選ばず|選択しな|選択せず|使わな|使わず|不可|ではなく|以外)|(?:not|no|without)[^\\n、。；;，,]{0,20}(?:workspace[\\s-]*members?|member[\\s-]*(?:picker|selection)))';
  return new RegExp(`(?:${label}${near}${negative}|${negative}${near}${label})`, 'iu').test(String(prompt || ''));
}

export function normalizeMemberFields(prompt, columns, { guidelines = '' } = {}) {
  if (!Array.isArray(columns)) return columns;
  return columns.map(column => {
    if (!column || typeof column !== 'object' || !MEMBER_FIELD.test(String(column.name || '').trim())) return column;
    const { options: _options, ...rest } = column;
    if (explicitlyFreeText(prompt, column.name) || explicitlyNoMember(prompt, column.name)) return column.type === 'person' ? { ...rest, type: 'text' } : column;
    if (!explicitlyMember(prompt, column.name) && (explicitlyFreeText(guidelines, column.name) || explicitlyNoMember(guidelines, column.name))) return column.type === 'person' ? { ...rest, type: 'text' } : column;
    return { ...rest, type: 'person' };
  });
}
