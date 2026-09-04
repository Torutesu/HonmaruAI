/** @typedef {{ recipientUserID: string, cardType: string, title: string, summary: string, context: string, priority: string, routingReason: string, agentRoute?: string, labels?: string[] }} DecisionCardArgs */

// Person node ids of the passed organization (the real members).
export function memberIdsOf(organization) {
  return (organization?.nodes || [])
    .filter((n) => n.kind === "person")
    .map((n) => n.id);
}

/// Display name for a user id: the org node's label without its role suffix,
/// falling back to the id — which, for a real organization, is a GitHub login
/// and already a name the team recognizes.
export function displayNameOf(organization, userID) {
  const node = (organization?.nodes || []).find((n) => n.id === userID && n.kind === "person");
  if (node?.label) return node.label.split(" \u00b7 ")[0].trim();
  return String(userID || "");
}

/// Thrown when there is nobody to route to.
///
/// This used to be answered with four invented colleagues — `user-toru` and
/// friends, left over from the demo — so an instruction sent before the org
/// graph had loaded, or by a guest who never had one, produced a card addressed
/// to a person who does not exist. The relay stored it, nobody could ever
/// decide it, and the sender was told it had been routed. An error the client
/// can act on is the honest answer, and the only one that does not quietly
/// lose work.
export class NoOrganizationError extends Error {
  constructor() {
    super("Load your organization before routing a decision.");
    this.name = "NoOrganizationError";
  }
}

/// Whether an instruction names this person.
///
/// A bare `includes` matched any member whose name happened to be a substring
/// of the sentence — `al` inside "already", `sam` inside "same" — and the match
/// then *overrode* the model's choice, so the better answer lost to an
/// accident. Latin names need a word boundary; a script that has no word
/// boundaries is matched directly, which is what that script allows. `@name`
/// counts either way, because an explicit mention is never an accident.
export function namesPerson(text, name) {
  const needle = String(name || "").trim();
  const haystack = String(text || "");
  if (!needle || !haystack) return false;
  if (haystack.toLowerCase().includes(`@${needle.toLowerCase()}`)) return true;
  if (/^[\x20-\x7e]+$/.test(needle)) {
    if (needle.length < 3) return false;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\w-])${escaped}([^\\w-]|$)`, "i").test(haystack);
  }
  return needle.length >= 2 && haystack.includes(needle);
}

function defaultRecipient(senderID, organization) {
  const members = memberIdsOf(organization);
  if (!members.length) throw new NoOrganizationError();
  // Something that needs signing off goes to someone who can sign it off.
  const approver = (organization.edges || []).find(
    (e) => e.kind === "canApprove" && e.fromID !== senderID && members.includes(e.fromID)
  );
  if (approver) return approver.fromID;
  return members.find((id) => id !== senderID) || members[0];
}

/// Who this instruction is for, before the model has said anything.
///
/// Three rules, in the order the PRD states them: a person named in the
/// instruction, then the sender's manager for an escalation, then whoever can
/// decide. Only the first overrides a model that disagreed — the other two are
/// guesses, and a guess should not beat a reading.
export function resolveRecipientTarget(text, senderID, organization) {
  const members = memberIdsOf(organization);
  if (!members.length) throw new NoOrganizationError();

  for (const userID of members) {
    if (userID === senderID) continue;
    const displayName = displayNameOf(organization, userID);
    if (namesPerson(text, displayName) || namesPerson(text, userID)) {
      return {
        recipientUserID: userID,
        routingReason: `Mentioned ${displayName}`,
        forceOverride: true,
      };
    }
  }

  const managerEdge = (organization?.edges || []).find(
    (item) => item.toID === senderID && item.kind === "manages"
  );
  if (managerEdge?.fromID && managerEdge.fromID !== senderID && members.includes(managerEdge.fromID)) {
    return {
      recipientUserID: managerEdge.fromID,
      routingReason: `Escalated to ${displayNameOf(organization, managerEdge.fromID)}`,
      forceOverride: false,
    };
  }

  return {
    recipientUserID: defaultRecipient(senderID, organization),
    routingReason: "Best match for this decision in the org graph",
    forceOverride: false,
  };
}

export function buildAgentTools(organization) {
  // The enum is the org's members and nothing else. It used to fall back to the
  // demo ids for an empty org, which is how a model was invited to route a real
  // instruction to a person who does not exist; an empty org is now refused
  // before the model is ever called.
  const recipientEnum = memberIdsOf(organization);
  return [
    {
      type: "function",
      function: {
        name: "create_decision_card",
        description:
          "Turn a messy workplace instruction into a structured decision card routed to the right teammate. Rewrite the sender's words — never echo them.",
        parameters: {
          type: "object",
          properties: {
            recipientUserID: {
              type: "string",
              ...(recipientEnum.length ? { enum: recipientEnum } : {}),
              description:
                "Who should receive and act on this decision. Pick an id from the members listed under Organization in the user message. Route by the org graph: a named person → that person; an approval → a member with a canApprove edge; an escalation → the sender's manager. Never pick an id that is not in the list.",
            },
            cardType: {
              type: "string",
              enum: ["approval", "delegation", "notification", "task", "revision"],
            },
            title: {
              type: "string",
              description: "3-8 words, action-oriented, no filler like 'tell Bob'",
            },
            summary: {
              type: "string",
              description: "1-2 sentences, third person, what the recipient must decide or do",
            },
            context: {
              type: "string",
              description:
                "2-4 structured facts as 'label: detail' segments separated by · e.g. 'deadline: Friday demo · metric: p95 +18% · scope: auth endpoint · action: hotfix branch'",
            },
            priority: {
              type: "string",
              enum: ["low", "medium", "high", "urgent"],
            },
            routingReason: {
              type: "string",
              description: "One sentence: why this person owns the decision",
            },
            labels: {
              type: "array",
              items: { type: "string" },
              description: "Optional GitHub-style labels e.g. bug, infra, blocked",
            },
          },
          required: [
            "recipientUserID",
            "cardType",
            "title",
            "summary",
            "context",
            "priority",
            "routingReason",
          ],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "set_priority",
        description:
          "Override urgency when the instruction clearly signals time sensitivity or low importance",
        parameters: {
          type: "object",
          properties: {
            level: { type: "string", enum: ["low", "medium", "high", "urgent"] },
            reason: { type: "string" },
          },
          required: ["level", "reason"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "add_context",
        description: "Attach extra structured context extracted from the instruction",
        parameters: {
          type: "object",
          properties: {
            key: { type: "string" },
            value: { type: "string" },
          },
          required: ["key", "value"],
          additionalProperties: false,
        },
      },
    },
  ];
}

const SYSTEM_PROMPT = `You route workplace instructions to the right teammate as structured Decision Cards.

Call create_decision_card once with all fields filled:
- Write title, summary, context and routingReason in the READER's language,
  given as "Reader language" below. The sender's language is irrelevant: an
  English instruction read by a Japanese user must produce a Japanese card.
  Deciding is the reader's job, so the card is written for them.
- Never echo the sender's exact wording in title or summary
- title: 3-8 words, action-oriented
- summary: third person, what the recipient must decide or do
- context: deadlines, metrics, amounts, blockers — always 2-4 segments as
  'label: detail' joined by ·. The app reads the label to choose an icon, so use
  only: deadline / scope / metric / amount / action — or in Japanese
  期限 / 範囲 / 指標 / 金額 / 対応.
- priority: infer from urgency cues in the instruction

Routing (critical):
- recipientUserID MUST be one of the member ids listed under Organization in the
  user message. Never invent an id or pick one that is not listed.
- A person named in the instruction → that person.
- Something that needs sign-off or approval → a member with a canApprove edge.
- An escalation → the sender's manager (a "manages" edge pointing at the sender).
- Otherwise pick the member whose role best fits the instruction.`;

export function buildUserPrompt({ text, sender, organization, readerLanguage, senderContext }) {
  const orgContext = organizationContext(organization);
  const contextBlock = senderContext && senderContext.trim()
    ? `\nSender context: ${senderContext.trim()}\n`
    : "";
  return `Sender: ${sender.name} (${sender.id}, ${sender.role})
Reader language: ${readerLanguage || "ja"}
Instruction: ${text}
${contextBlock}
Organization:
${orgContext}`;
}

function organizationContext(organization) {
  const nodes = (organization?.nodes || [])
    .map((node) => `- ${node.id}: ${node.label} (${node.kind})`)
    .join("\n");
  const edges = (organization?.edges || [])
    .map((edge) => {
      const from =
        organization.nodes?.find((node) => node.id === edge.fromID)?.label ||
        edge.fromID;
      const to =
        organization.nodes?.find((node) => node.id === edge.toID)?.label ||
        edge.toID;
      return `- ${from} ${edge.kind} ${to}`;
    })
    .join("\n");
  return `Nodes:\n${nodes}\nEdges:\n${edges}`;
}

function parseToolArguments(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  return JSON.parse(raw);
}

/**
 * @param {import('openai').ChatCompletionMessageToolCall[] | undefined} toolCalls
 * @param {string} senderName
 */
export function materializeFromToolCalls(toolCalls, senderName, organization) {
  /** @type {DecisionCardArgs | null} */
  let card = null;
  /** @type {{ name: string, label: string, detail: string }[]} */
  const steps = [];
  let priorityOverride = null;
  const contextExtras = [];

  for (const call of toolCalls || []) {
    const name = call.function?.name;
    const args = parseToolArguments(call.function?.arguments);

    if (name === "create_decision_card") {
      card = args;
      steps.push({
        name: "create_decision_card",
        label: "Route decision",
        detail: `${displayNameOf(organization, args.recipientUserID)} · ${args.cardType}`,
      });
    }

    if (name === "set_priority") {
      priorityOverride = args.level;
      steps.push({
        name: "set_priority",
        label: "Set priority",
        detail: `${args.level}${args.reason ? ` — ${args.reason}` : ""}`,
      });
    }

    if (name === "add_context") {
      contextExtras.push(`${args.key}: ${args.value}`);
      steps.push({
        name: "add_context",
        label: "Add context",
        detail: `${args.key}: ${args.value}`,
      });
    }
  }

  if (!card) {
    throw new Error("AI did not call create_decision_card.");
  }

  if (priorityOverride) {
    card.priority = priorityOverride;
  }

  if (contextExtras.length > 0) {
    card.context = [card.context, ...contextExtras].filter(Boolean).join(" · ");
  }

  const recipientName = displayNameOf(organization, card.recipientUserID);
  card.agentRoute = `${senderName}'s AI → ${recipientName}'s AI`;

  return { card, toolCalls: steps };
}

function resolveRecipient(text, senderID, organization) {
  const target = resolveRecipientTarget(text, senderID, organization);
  return {
    recipientUserID: target.recipientUserID,
    namedInInstruction: target.forceOverride,
    routingReason: target.routingReason,
  };
}

function routingReasonFor({
  recipientUserID,
  senderID,
  namedInInstruction,
  organization,
  routingReason,
}) {
  if (routingReason) return routingReason;
  if (namedInInstruction) return "Named in your instruction";
  const managerEdge = organization?.edges?.find(
    (item) => item.toID === senderID && item.kind === "manages"
  );
  if (managerEdge?.fromID === recipientUserID) {
    return `You are ${displayNameOf(organization, senderID)}'s manager`;
  }
  if (recipientUserID !== senderID) {
    return "Best match for this decision in org graph";
  }
  return "Routed to you";
}

function isEchoOfInput(summary, input) {
  const normalize = (value) =>
    String(value || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  const a = normalize(summary);
  const b = normalize(input);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= b.length * 0.75 && b.includes(a)) return true;
  if (b.length >= a.length * 0.75 && a.includes(b)) return true;
  return false;
}

function summarizeInstruction(text, { sender, cardType, recipientUserID, organization }) {
  let cleaned = String(text || "").trim();
  // "Ask hubot to ..." is addressed to the AI, not to the reader: the card says
  // who it is for in its own right. The name stripped here is the recipient's
  // real one — this used to hunt for alice, bob, carol and dana, who left with
  // the demo.
  const recipientName = displayNameOf(organization, recipientUserID);
  const named = [recipientName, recipientUserID]
    .filter((value) => value && /^[\x20-\x7e]+$/.test(value))
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  if (named) {
    cleaned = cleaned.replace(
      new RegExp(`^(please\\s+)?(tell|ask|notify|send|ping|remind)\\s+@?(${named})\\s+(to\\s+)?`, "i"),
      ""
    );
    cleaned = cleaned.replace(
      new RegExp(`^(i need|we need)\\s+@?(${named})\\s+to\\s+`, "i"),
      ""
    );
  }
  cleaned = cleaned.replace(/^(can you|could you|hey|hi|yo)\s+/i, "");
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }

  const titles = {
    approval: "Approval needed",
    delegation: `Task for ${recipientName}`,
    revision: "Revision requested",
    task: cleaned.split(" ").slice(0, 6).join(" ").slice(0, 48) || "New task",
    notification: `Update for ${recipientName}`,
  };

  const summary =
    cleaned.length > 180 ? `${cleaned.slice(0, 177).trim()}…` : cleaned;

  return {
    title: titles[cardType] || "Decision needed",
    summary: summary || "Decision requested.",
    context: `From ${sender.name} · decision routed to ${recipientName}`,
  };
}

function applyRoutingGuard(routing, sender, originalText, organization = null) {
  const target = resolveRecipientTarget(originalText, sender.id, organization);
  if (!target.forceOverride || target.recipientUserID === routing.recipientUserID) {
    return routing;
  }

  const recipientName = displayNameOf(organization, target.recipientUserID);
  return {
    ...routing,
    recipientUserID: target.recipientUserID,
    routingReason: target.routingReason,
    agentRoute: `${sender.name}'s AI → ${recipientName}'s AI`,
    toolCalls: [
      ...(routing.toolCalls || []),
      {
        name: "route_correction",
        label: "Auto-routed by team/role",
        detail: recipientName,
      },
    ],
  };
}

function validateRouting(routingJSON, sender, originalText, toolCalls = [], organization = null) {
  const members = memberIdsOf(organization);
  // An empty org has no valid recipient, so there is nothing to validate
  // against. It is refused before the model is called; reaching here means a
  // caller skipped that check, and inventing a recipient is what this replaced.
  if (!members.length) throw new NoOrganizationError();
  const allowedRecipients = new Set(members);
  const allowedTypes = new Set([
    "approval",
    "delegation",
    "notification",
    "task",
    "revision",
  ]);
  const allowedPriorities = new Set(["low", "medium", "high", "urgent"]);

  const recipientUserID = routingJSON.recipientUserID;
  const cardType = routingJSON.cardType;
  let title = routingJSON.title;
  let summary = routingJSON.summary;
  let context = routingJSON.context;
  const priority = routingJSON.priority;

  if (!allowedRecipients.has(recipientUserID)) {
    throw new Error("AI picked an invalid recipient.");
  }
  if (!allowedTypes.has(cardType)) {
    throw new Error("AI returned an invalid card type.");
  }
  if (!allowedPriorities.has(priority)) {
    throw new Error("AI returned an invalid priority.");
  }
  if (!title || !summary || !context) {
    throw new Error("AI returned incomplete routing fields.");
  }

  if (isEchoOfInput(summary, originalText) || isEchoOfInput(title, originalText)) {
    const rewritten = summarizeInstruction(originalText, {
      sender,
      cardType,
      recipientUserID,
      organization,
    });
    title = rewritten.title;
    summary = rewritten.summary;
    context = rewritten.context;
  }

  const recipientName = displayNameOf(organization, recipientUserID);
  const agentRoute =
    routingJSON.agentRoute || `${sender.name}'s AI → ${recipientName}'s AI`;
  const routingReason =
    routingJSON.routingReason || "Best match for this decision in org graph";

  return applyRoutingGuard(
    {
      recipientUserID,
      cardType,
      title,
      summary,
      context,
      priority,
      agentRoute,
      routingReason,
      labels: routingJSON.labels || [],
      toolCalls,
    },
    sender,
    originalText,
    organization
  );
}

export function routeInstructionLocally({
  text,
  sender,
  organization,
  priorityOverride,
}) {
  const lower = String(text || "").toLowerCase();
  const { recipientUserID, namedInInstruction, routingReason } = resolveRecipient(
    text,
    sender.id,
    organization
  );

  let cardType = "notification";
  if (lower.includes("approve") || lower.includes("approval")) cardType = "approval";
  else if (lower.includes("delegate") || lower.includes("assign")) cardType = "delegation";
  else if (lower.includes("revise") || lower.includes("feedback")) cardType = "revision";
  else if (lower.includes("task") || lower.includes("fix") || lower.includes("build")) {
    cardType = "task";
  }

  const rewritten = summarizeInstruction(text, {
    sender,
    cardType,
    recipientUserID,
    organization,
  });
  const recipientName = displayNameOf(organization, recipientUserID);
  const priority =
    priorityOverride && ["low", "medium", "high", "urgent"].includes(priorityOverride)
      ? priorityOverride
      : lower.includes("urgent")
        ? "urgent"
        : "high";

  return validateRouting(
    {
      recipientUserID,
      cardType,
      title: rewritten.title,
      summary: rewritten.summary,
      context: rewritten.context,
      priority,
      agentRoute: `${sender.name}'s AI → ${recipientName}'s AI`,
      routingReason: routingReasonFor({
        recipientUserID,
        senderID: sender.id,
        namedInInstruction,
        organization,
        routingReason,
      }),
      labels: [],
    },
    sender,
    text,
    [
      {
        name: "create_decision_card",
        label: "Local fallback route",
        detail: `${recipientName} · ${cardType}`,
      },
    ],
    organization
  );
}

function parseRoutingJSON(content) {
  const trimmed = String(content || "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  return JSON.parse(candidate);
}

async function routeInstructionWithOpenRouter({
  text,
  sender,
  organization,
  priorityOverride,
  openRouter,
  readerLanguage,
  senderContext,
  attempt = 0,
  // Shared with the caller (and with this function's own retry) so it can tell
  // "the model answered" from "the call never landed" even when both end up
  // throwing. Only the first is billable.
  call = { answered: false },
}) {
  const userPrompt = buildUserPrompt({ text, sender, organization, readerLanguage, senderContext });

  // OpenAI and OpenRouter speak the same chat/completions dialect, tools
  // included, so the provider is just an endpoint and a couple of headers.
  // OpenRouter wants attribution headers; OpenAI ignores them, so they are only
  // sent when they exist.
  const endpoint = openRouter.endpoint || "https://openrouter.ai/api/v1/chat/completions";
  const headers = {
    Authorization: `Bearer ${openRouter.apiKey}`,
    "Content-Type": "application/json",
  };
  if (openRouter.appUrl) headers["HTTP-Referer"] = openRouter.appUrl;
  if (openRouter.appName) headers["X-Title"] = openRouter.appName;

  const response = await fetch(endpoint, {
    method: "POST",
    // Routing runs inside the request the app is waiting on, and on the socket
    // handler when a card is rendered. A provider that stops answering has to
    // become the keyword fallback, not a stalled Durable Object.
    signal: AbortSignal.timeout(20_000),
    headers,
    body: JSON.stringify({
      model: openRouter.model,
      temperature: 0.2,
      max_tokens: 512,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      tools: buildAgentTools(organization),
      tool_choice: {
        type: "function",
        function: { name: "create_decision_card" },
      },
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    const message = data?.error?.message || `${openRouter.providerName || "LLM"} request failed.`;
    throw new Error(message);
  }
  // Past this line the provider has answered and billed us, whatever we go on
  // to make of the answer — including rejecting it in validateRouting below.
  call.answered = true;

  const message = data?.choices?.[0]?.message;
  const toolCalls = message?.tool_calls;

  if (toolCalls?.length) {
    const { card, toolCalls: steps } = materializeFromToolCalls(toolCalls, sender.name, organization);
    if (priorityOverride && ["low", "medium", "high", "urgent"].includes(priorityOverride)) {
      card.priority = priorityOverride;
      steps.push({
        name: "set_priority",
        label: "Priority override",
        detail: priorityOverride,
      });
    }
    return validateRouting(card, sender, text, steps, organization);
  }

  const content = message?.content;
  if (!content) {
    if (attempt < 1) {
      return routeInstructionWithOpenRouter({
        text,
        sender,
        organization,
        priorityOverride,
        openRouter,
        readerLanguage,
        senderContext,
        attempt: attempt + 1,
        call,
      });
    }
    console.warn("OpenRouter returned empty routing response; using local fallback.");
    return routeInstructionLocally({ text, sender, organization, priorityOverride });
  }

  const routingJSON = parseRoutingJSON(content);
  const validated = validateRouting(
    routingJSON,
    sender,
    text,
    [
      {
        name: "create_decision_card",
        label: "Route decision",
        detail: `${displayNameOf(organization, routingJSON.recipientUserID)} · ${routingJSON.cardType}`,
      },
    ],
    organization
  );
  if (priorityOverride) {
    validated.priority = priorityOverride;
  }
  return validated;
}

export async function routeInstruction({
  text,
  sender,
  organization,
  priorityOverride,
  openRouter,
  readerLanguage,
  senderContext,
}) {
  if (openRouter?.apiKey) {
    // `aiCalled` is for the meter, not for clients: /ai/route strips it before
    // responding, so the wire format is unchanged. routedBy cannot stand in for
    // it — a model that answers with an invalid recipient is rejected below and
    // reported as "fallback", but we were still billed for the answer.
    const call = { answered: false };
    try {
      const routed = await routeInstructionWithOpenRouter({
        text,
        sender,
        organization,
        priorityOverride,
        openRouter,
        readerLanguage,
        senderContext,
        call,
      });
      return { ...routed, routedBy: openRouter.providerName || "llm", aiCalled: call.answered };
    } catch (error) {
      console.warn("AI routing failed, using local fallback:", error.message);
      return {
        ...routeInstructionLocally({ text, sender, organization, priorityOverride }),
        routedBy: "fallback",
        routingError: error.message,
        aiCalled: call.answered,
      };
    }
  }

  return {
    ...routeInstructionLocally({ text, sender, organization, priorityOverride }),
    routedBy: "fallback",
    aiCalled: false,
  };
}

export { SYSTEM_PROMPT };
