// Email triage: keyword-based classification only. There is no LLM triage
// module elsewhere in this repo to call into (unlike the Gmail/Slack
// connectors' triage, which uses OpenAI) — wiring that up is real follow-up
// work, not something to fake behind a try/catch that always fails.

// Checked first: an FYI-style email should never be flagged as needing a
// decision even if it happens to contain a word like "need" (e.g. "no
// action needed"). Matched only against the new content (see
// stripQuotedReplies) — otherwise a single "heads up" anywhere in a long
// quoted thread suppresses classification of the actual new message.
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
  // Plain /\bdue\b/ matched "due to", "due in part to", etc. — narrowed to
  // phrasings that actually indicate a deadline.
  high: [/\bsoon\b/, /\btoday\b/, /\bdeadline\b/, /\bdue (today|tomorrow|by|date|on)\b/],
  low: [/\bwhenever\b/, /\bno rush\b/],
};

// Common markers for where a reply's quoted history starts. Truncating here
// means classification only ever looks at what the sender actually wrote,
// not at whatever was said earlier in the thread.
const QUOTE_START_PATTERNS = [
  /^-{2,}\s*original message\s*-{2,}/im,
  /^on .+ wrote:\s*$/im,
  /^_{5,}\s*$/m, // Outlook's horizontal-rule separator
  /^>/m, // first line of a ">"-quoted block
];

function stripQuotedReplies(text) {
  let cutoff = text.length;
  for (const pattern of QUOTE_START_PATTERNS) {
    const match = pattern.exec(text);
    if (match && match.index < cutoff) cutoff = match.index;
  }
  return text.slice(0, cutoff);
}

/**
 * Classify an email as a decision request or not. Only the sender's new
 * content is considered — quoted history from earlier in the thread is
 * stripped first.
 * @param {string} subject
 * @param {string} body
 * @returns {{ needs_decision: boolean, card_type: string, priority: string, summary: string, context: string }}
 */
async function triageEmail(subject, body) {
  const combinedText = `${subject} ${stripQuotedReplies(body)}`.toLowerCase();

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
