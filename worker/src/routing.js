/** @typedef {{ recipientUserID: string, cardType: string, title: string, summary: string, context: string, priority: string, routingReason: string, agentRoute?: string, labels?: string[] }} DecisionCardArgs */

export const DEMO_USER_IDS = ["user-toru", "user-tanaka", "user-yui", "user-alex"];

// Person node ids of the passed organization (the real members).
export function memberIdsOf(organization) {
  return (organization?.nodes || [])
    .filter((n) => n.kind === "person")
    .map((n) => n.id);
}
// Pull { id, name, role } out of the org nodes. The label is "Name · role".
function membersWithRoles(organization) {
  return (organization?.nodes || [])
    .filter((n) => n.kind === "person")
    .map((n) => {
      const [name, role] = String(n.label || "").split(" · ");
      return { id: n.id, name: (name || n.id).trim(), role: (role || "member").trim().toLowerCase() };
    });
}

// Route by a role word in the instruction to a real teammate who holds that
// role. "ask the designer to review" -> the person whose role is "designer".
// Uses the actual team, so it works for any org instead of hardcoded demo ids.
function matchRealRole(text, senderID, organization) {
  const lower = String(text || "").toLowerCase();
  const members = membersWithRoles(organization);
  // Common role words people actually type, mapped to role names.
  const roleWords = {
    designer: ["designer", "design", "デザイナー"],
    engineer: ["engineer", "developer", "dev", "エンジニア"],
    admin: ["admin", "owner", "lead", "manager"],
    triager: ["triager", "triage"],
    maintainer: ["maintainer"],
  };
  for (const [role, words] of Object.entries(roleWords)) {
    if (!words.some((w) => lower.includes(w))) continue;
    const person = members.find((m) => m.role === role && m.id !== senderID);
    if (person) {
      return { recipientUserID: person.id, routingReason: `Routed to the ${role}`, forceOverride: false };
    }
  }
  return null;
}

// Display name for a user id: prefer the org node label ("<name> · <role>"),
// then the demo map, then the raw id.
export function displayNameOf(organization, userID) {
  const node = (organization?.nodes || []).find((n) => n.id === userID && n.kind === "person");
  if (node?.label) return node.label.split(" · ")[0].trim();
  return userNameFor(userID);
}

/// A one-person business: unless the work clearly belongs to the contractor or
/// the client, the owner decides. Defaulting anywhere else invents a colleague.
/// (For a real org, defaultRecipient picks a member instead of a demo id.)

const TEAM_ROUTES = [
  {
    phrases: ["デザイナー", "外注", "designer", "contractor"],
    userID: "user-yui",
    label: "Design",
  },
  {
    phrases: ["クライアント", "先方", "取引先", "client", "customer"],
    userID: "user-tanaka",
    label: "Client",
  },
];

const ROLE_ROUTES = [
  {
    phrases: ["ロゴ", "バナー", "デザイン", "画像", "ヒーロー", "logo", "banner", "design", "figma"],
    userID: "user-yui",
    reason: "Visual work goes to the contractor",
  },
  {
    phrases: ["納品", "検収", "先方確認", "承認依頼", "delivery", "sign-off", "change order"],
    userID: "user-tanaka",
    reason: "The client has to agree to this",
  },
  {
    phrases: ["実装", "デプロイ", "バグ", "サーバー", "コード", "deploy", "bug", "server", "code", "staging"],
    userID: "user-alex",
    reason: "Engineering work goes to Alex",
  },
  {
    phrases: ["請求", "見積", "入金", "経費", "単価", "値上げ", "invoice", "quote", "pricing", "payment"],
    userID: "user-toru",
    reason: "Money decisions are yours alone",
  },
];


function defaultRecipient(senderID, organization) {
  const members = memberIdsOf(organization);
  if (!members.length) return "user-toru"; // demo fallback
  const approver = (organization.edges || []).find(
    (e) => e.kind === "canApprove" && e.fromID !== senderID && members.includes(e.fromID)
  );
  if (approver) return approver.fromID;
  return members.find((id) => id !== senderID) || members[0];
}

function matchTeamRoute(text, senderID, organization) {
  const lower = String(text || "").toLowerCase();
  const members = memberIdsOf(organization);
  for (const route of TEAM_ROUTES) {
    if (route.userID === senderID) continue;
    if (members.length && !members.includes(route.userID)) continue;
    if (route.phrases.some((phrase) => lower.includes(phrase))) {
      return route;
    }
  }
  return null;
}

function matchRoleRoute(text, senderID, organization) {
  const lower = String(text || "").toLowerCase();
  const members = memberIdsOf(organization);
  for (const route of ROLE_ROUTES) {
    if (route.userID === senderID) continue;
    if (members.length && !members.includes(route.userID)) continue;
    if (route.phrases.some((phrase) => lower.includes(phrase))) {
      return route;
    }
  }
  return null;
}

export function resolveRecipientTarget(text, senderID, organization) {
  const lower = String(text || "").toLowerCase();

  const members = memberIdsOf(organization);
  const candidateIds = members.length ? members : DEMO_USER_IDS;
  for (const userID of candidateIds) {
    if (userID === senderID) continue;
    const displayName = displayNameOf(organization, userID);
    const nameLower = displayName.toLowerCase();
    if (nameLower && lower.includes(nameLower)) {
      return {
        recipientUserID: userID,
        routingReason: `Mentioned ${displayName}`,
        forceOverride: true,
      };
    }
  }
    // Prefer routing to a real teammate by their actual role in this org.
  const realRole = matchRealRole(text, senderID, organization);
  if (realRole) return realRole;

  const team = matchTeamRoute(text, senderID, organization);
  if (team) {
    return {
      recipientUserID: team.userID,
      routingReason: `Routed to ${team.label} team · ${userNameFor(team.userID)}`,
      forceOverride: true,
    };
  }

  const role = matchRoleRoute(text, senderID, organization);
  if (role) {
    return {
      recipientUserID: role.userID,
      routingReason: role.reason,
      forceOverride: true,
    };
  }

  if (lower.includes("manager")) {
    const edge = organization?.edges?.find(
      (item) => item.toID === senderID && item.kind === "manages"
    );
    if (edge) {
      return {
        recipientUserID: edge.fromID,
        routingReason: `You are ${userNameFor(senderID)}'s manager`,
        forceOverride: true,
      };
    }
  }

  const managerEdge = organization?.edges?.find(
    (item) => item.toID === senderID && item.kind === "manages"
  );
  if (managerEdge?.fromID && managerEdge.fromID !== senderID) {
    return {
      recipientUserID: managerEdge.fromID,
      routingReason: `Escalated to ${userNameFor(managerEdge.fromID)}`,
      forceOverride: false,
    };
  }

  // In a one-person business the decision usually comes back to the owner, so
  // routing to yourself is the right answer rather than a bug. Picking "anyone
  // but the sender" hands your own work to a client.
  return {
    recipientUserID: defaultRecipient(senderID, organization),
    routingReason: "This one is yours to decide",
    forceOverride: false,
  };
}

export function buildAgentTools(organization) {
  const members = memberIdsOf(organization);
  const recipientEnum = members.length ? members : DEMO_USER_IDS;
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
              enum: recipientEnum,
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

// Back-compat: any importer of the old constant gets the demo-id variant.
export const AGENT_TOOLS = buildAgentTools(null);

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

function userNameFor(userID) {
  if (userID === "user-toru") return "Toru";
  if (userID === "user-tanaka") return "田中";
  if (userID === "user-yui") return "結衣";
  if (userID === "user-alex") return "Alex";
  // Email users have ids like "email:kinjal@test.com". Show the part before
  // the @, capitalized, instead of the raw id — "Kinjal" rather than
  // "email:kinjal@test.com".
  if (userID.startsWith("email:")) {
    const local = userID.slice("email:".length).split("@")[0];
    return local.charAt(0).toUpperCase() + local.slice(1);
  }
  return userID;
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
export function materializeFromToolCalls(toolCalls, senderName) {
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
        detail: `${userNameFor(args.recipientUserID)} · ${args.cardType}`,
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

  const recipientName = userNameFor(card.recipientUserID);
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
    return `You are ${userNameFor(senderID)}'s manager`;
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

function summarizeInstruction(text, { sender, cardType, recipientUserID }) {
  let cleaned = String(text || "").trim();
  cleaned = cleaned.replace(
    /^(please\s+)?(tell|ask|notify|send|ping|remind)\s+(alice|bob|carol|dana|manager)\s+(to\s+)?/i,
    ""
  );
  cleaned = cleaned.replace(/^(can you|could you|hey|hi|yo)\s+/i, "");
  cleaned = cleaned.replace(
    /^(i need|we need)\s+(alice|bob|carol|dana|manager)\s+to\s+/i,
    ""
  );
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }

  const recipientName = userNameFor(recipientUserID);
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

  const recipientName = userNameFor(target.recipientUserID);
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
  const allowedRecipients = new Set(members.length ? members : DEMO_USER_IDS);
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
    });
    title = rewritten.title;
    summary = rewritten.summary;
    context = rewritten.context;
  }

  const recipientName = userNameFor(recipientUserID);
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
  });
  const recipientName = userNameFor(recipientUserID);
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
    const { card, toolCalls: steps } = materializeFromToolCalls(toolCalls, sender.name);
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

export { SYSTEM_PROMPT, userNameFor };
