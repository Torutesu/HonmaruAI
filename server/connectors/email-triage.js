// Email triage: keyword-based classification only. There is no LLM triage
// module elsewhere in this repo to call into (unlike the Gmail/Slack
// connectors' triage, which uses OpenAI) — wiring that up is real follow-up
// work, not something to fake behind a try/catch that always fails.

// Checked first: an FYI-style email should never be flagged as needing a
// decision even if it happens to contain a word like "need" (e.g. "no
// action needed").
const NEGATIVE_PATTERNS = [
  /\bfyi\b/,
  /\bno action needed\b/,
  /\bno action required\b/,
  /\bfor your information\b/,
  /\bheads up\b/,
  /\bjust letting you know\b/,
];

// Word-boundary regexes, not plain substring includes — substring matching
// let "need" match inside "needed" and produced false positives on FYI mail.
const DECISION_PATTERNS = [
  /\breview\b/, /\bapprove\b/, /\bapproval\b/, /\bfeedback\b/,
  /\bthoughts\?/, /\bcan you\b/, /\bcould you\b/,
  /\bplease (review|approve|check|confirm|decide)\b/,
  /\bwhat do you think\b/, /\bneed(s)? (your|a) (approval|decision|review|input|feedback)\b/,
];

const URGENCY_PATTERNS = {
  urgent: [/\basap\b/, /\burgent\b/, /\bimmediately\b/, /\bcritical\b/],
  high: [/\bsoon\b/, /\btoday\b/, /\bdeadline\b/, /\bdue\b/],
  low: [/\bwhenever\b/, /\bno rush\b/],
};

/**
 * Classify an email as a decision request or not.
 * @param {string} subject
 * @param {string} body
 * @returns {{ needs_decision: boolean, card_type: string, priority: string, summary: string, context: string }}
 */
async function triageEmail(subject, body) {
  const combinedText = `${subject} ${body}`.toLowerCase();

  if (NEGATIVE_PATTERNS.some((re) => re.test(combinedText))) {
    return { needs_decision: false, card_type: "notification", priority: "low", summary: subject, context: body };
  }

  const needsDecision = DECISION_PATTERNS.some((re) => re.test(combinedText));

  let priority = "medium";
  for (const [level, patterns] of Object.entries(URGENCY_PATTERNS)) {
    if (patterns.some((re) => re.test(combinedText))) {
      priority = level;
      break;
    }
  }

  return { needs_decision: needsDecision, card_type: "approval", priority, summary: subject, context: body };
}

export { triageEmail };
