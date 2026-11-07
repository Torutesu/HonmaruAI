import { describe, expect, test } from 'vitest';
import { parseRemoteHandoff, remoteHandoffInstruction } from '../src/harness/remoteHandoff.js';

describe('remote Agent handoff contract', () => {
  test('offers only the eligible room Agents and documents an explicit final-line control marker', () => {
    const instruction = remoteHandoffInstruction([{ id: 'agent-1', name: 'Reviewer', handle: 'reviewer' }]);
    expect(instruction).toContain('agent-1 (Reviewer, @reviewer)');
    expect(instruction).toContain('[[HONMARU_HANDOFF:{"targetAgentId":"AGENT_ID","brief":"What the next Agent should do"}]]');
    expect(remoteHandoffInstruction([])).toBe('');
  });

  test('parses a final explicit handoff line without losing the answer before it', () => {
    expect(parseRemoteHandoff('I found the issue.\n[[HONMARU_HANDOFF:{"targetAgentId":"agent-2","brief":"Review the migration"}]]'))
      .toEqual({ text: 'I found the issue.', handoff: { targetAgentId: 'agent-2', brief: 'Review the migration' } });
    expect(parseRemoteHandoff('I found the issue.\n[[HONMARU_HANDOFF:{\\"targetAgentId\\":\\"agent-2\\",\\"brief\\":\\"Review the migration\\"}]]'))
      .toEqual({ text: 'I found the issue.', handoff: { targetAgentId: 'agent-2', brief: 'Review the migration' } });
  });

  test.each([
    'ordinary answer mentioning [[HONMARU_HANDOFF:marker]] inline',
    '[[HONMARU_HANDOFF:{"targetAgentId":"","brief":"Review"}]]',
    '[[HONMARU_HANDOFF:{"targetAgentId":"agent-2","brief":" "}]]',
    '[[HONMARU_HANDOFF:{"targetAgentId":"agent-2","brief":"Review","execute":"dangerously"}]]',
    'answer\n[[HONMARU_HANDOFF:{broken json}]]',
  ])('does not treat non-contract text as a handoff: %s', text => {
    expect(parseRemoteHandoff(text)).toBeNull();
  });
});
