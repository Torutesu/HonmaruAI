// A local routing pass avoids an extra model request just to choose a teammate.
// Only clear human requests enter this pass; ambiguity stays between people.
const REQUEST = /^(?:please\b|(?:summarize|summarise|translate|review|research|investigate|draft|calculate|explain|compare|analyze|analyse|help me)\b)|^(?:could you|can you|would you)\b|(?:教えて|調べて|調査して|まとめて|要約して|翻訳して|確認して|計算して|比較して|分析して|作成して|手伝って)(?:ください|下さい|ほしい|ほしいです|もらえますか|くれますか)?[。？！?!\s]*$|お願い(?:します)?[。？！?!\s]*$/iu;
const WORDS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2,}|[\p{L}\p{N}]{3,}/gu;
const STOP = new Set(['the', 'and', 'for', 'with', 'you', 'your', 'this', 'that', 'please', 'agent', 'help', 'helpful']);
export function isRoomRequest(text) {
  const body = String(text || '').trim();
  return body.length > 3 && !/^[^。\n?!]{1,50}(?:さん|様)[、,\s]/u.test(body) && REQUEST.test(body) && !/^(?:thanks|thank you|ありがとう|了解|承知|お疲れ)/iu.test(body);
}
export function chooseRoomAgent(text, agents, profiles = new Map()) {
  if (!isRoomRequest(text) || !agents.length) return null;
  const message = String(text).normalize('NFKC').toLocaleLowerCase();
  let best = agents[0], score = 0;
  for (const agent of agents) {
    const specialty = profiles.get(agent.id)?.specialty || '';
    const words = new Set(`${specialty} ${agent.description || ''}`.normalize('NFKC').toLocaleLowerCase().match(WORDS) || []);
    const value = [...words].filter(word => !STOP.has(word) && message.includes(word)).reduce((sum, word) => sum + Math.min(word.length, 12), 0);
    if (value > score) { best = agent; score = value }
  }
  return best;
}
