import { expect, test } from 'vitest';
import { chooseRoomAgent, isRoomRequest } from '../src/harness/roomRouting.js';
test('clear requests route by specialty with a stable room-member fallback', () => {
  const agents = [{ id: 'general', description: 'General help' }, { id: 'finance', description: 'Invoices and accounting' }];
  const profiles = new Map([['finance', { specialty: '請求書' }]]);
  expect(chooseRoomAgent('Please review these invoices', agents, profiles).id).toBe('finance');
  expect(chooseRoomAgent('請求書を確認してください', agents, profiles).id).toBe('finance');
  expect(chooseRoomAgent('Please explain the next steps', agents, profiles).id).toBe('general');
  expect(chooseRoomAgent('Please help', [])).toBeNull();
});
test('ordinary status, acknowledgements and greetings do not trigger routing', () => {
  for (const text of ['Thanks for the review', 'ありがとう、確認してくれて助かりました', 'Hello everyone', 'The release is complete', 'I will review it tomorrow', 'Toru, can you review this?', '田中さん、請求書を確認してください', '確認してくれました', '本日の売上は昨日と同じです', '了解しました']) expect(isRoomRequest(text)).toBe(false);
});
