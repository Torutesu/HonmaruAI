// The words on a card that nobody wrote.
//
// A card's summary is the person's own sentence and stays in the language they
// typed it in. Its title and its routing line are ours — "Approval needed",
// "From Mai · decision routed to Ken" — and with no AI key configured the
// fallback router put those in English in front of a Japanese reader, which is
// the half of "the language switch does nothing" that lives on the server.
//
// English is the key, as in the client's own table, so an untranslated string
// degrades to English rather than to a key name.

const JA = {
  "Approval needed": "承認が必要です",
  "Revision requested": "修正の依頼",
  "Decision needed": "判断が必要です",
  "New task": "新しいタスク",
  "Your task": "あなたのタスク",
  "Your note": "あなたのメモ",
  "Task for {name}": "{name}へのタスク",
  "Update for {name}": "{name}への連絡",
  "From your own AI": "あなた自身のAIから",
  "From {sender} · decision routed to {recipient}": "{sender}から · {recipient}に振り分け",
  "Decision requested.": "判断をお願いします。",
  "{name} has left this workspace, so this came back to you.":
    "{name}さんはこのワークスペースを離れたため、これはあなたに戻されました。",
};

const TABLES = { ja: JA };

/// `locale` may be a full tag ("ja-JP"); only the language part decides.
export function cardText(locale, key, vars) {
  const lang = String(locale || "en").toLowerCase().split(/[-_]/)[0];
  let out = (TABLES[lang] && TABLES[lang][key]) || key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      out = out.split(`{${name}}`).join(String(value));
    }
  }
  return out;
}
