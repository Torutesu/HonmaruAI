const MARKER = /^\[\[HONMARU_HANDOFF:(\{[^\r\n]{1,17000}\})\]\]\s*$/;

export function remoteHandoffInstruction(targets) {
  if (!targets.length) return '';
  const choices = targets.map(target => `${target.id} (${target.name}, @${target.handle})`).join('; ');
  return [
    'If you cannot complete this task alone and want another room Agent to take over, end your response with one final line in exactly this format:',
    '[[HONMARU_HANDOFF:{"targetAgentId":"AGENT_ID","brief":"What the next Agent should do"}]]',
    `Choose targetAgentId only from these available room Agents: ${choices}. The brief must be under 16,000 characters. This transfers ownership and your response will not be posted as the final answer. Do not emit this marker for an ordinary answer.`,
  ].join('\n');
}

export function parseRemoteHandoff(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(/(?:^|\n)(\[\[HONMARU_HANDOFF:\{[^\r\n]{1,17000}\}\]\])\s*$/);
  if (!match) return null;
  const marker = match[1].match(MARKER);
  if (!marker) return null;
  let handoff;
  try { handoff = JSON.parse(marker[1]); }
  catch {
    // Some external-agent APIs escape a JSON fragment while preserving the
    // surrounding text block. Accept that one encoding only, then validate the
    // exact object shape below; never evaluate provider output as code.
    try { handoff = JSON.parse(marker[1].replace(/\\(["\\])/g, '$1')); } catch { return null; }
  }
  if (!handoff || typeof handoff !== 'object' || Array.isArray(handoff)
    || Object.keys(handoff).some(key => !['targetAgentId','brief'].includes(key))
    || typeof handoff.targetAgentId !== 'string' || !handoff.targetAgentId || handoff.targetAgentId.length > 100
    || typeof handoff.brief !== 'string' || !handoff.brief.trim() || handoff.brief.length > 16000) return null;
  return { handoff: { targetAgentId: handoff.targetAgentId, brief: handoff.brief.trim() }, text: text.slice(0, match.index).trim() };
}
