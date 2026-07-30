/** @typedef {{ recipientUserID: string, cardType: string, title: string, summary: string, context: string, priority: string, routingReason: string, agentRoute?: string, labels?: string[] }} DecisionCardArgs */

export const DEMO_USER_IDS = [
  "user-alice",
  "user-bob",
  "user-carol",
  "user-dana",
];

const TEAM_ROUTES = [
  {
    phrases: ["design team", "designers", "designer", " ux", "ui team", "design dept"],
    userID: "user-carol",
    label: "Design",
  },
  {
    phrases: ["engineering team", "eng team", "engineers", "dev team", "developers", "engineering"],
    userID: "user-dana",
    label: "Engineering",
  },
  {
    phrases: ["product team", "product managers", "pm team", "product manager"],
    userID: "user-alice",
    label: "Product",
  },
];

const ROLE_ROUTES = [
  {
    phrases: ["mockup", "figma", "pixel", "spacing", "empty state", "visual", "ui ", "ux ", "design system", "copy pass"],
    userID: "user-carol",
    reason: "Design work detected in instruction",
  },
  {
    phrases: ["bug", "fix", "api", "deploy", "latency", "hotfix", "backend", "auth", "endpoint", "pr #", "merge", "regression"],
    userID: "user-bob",
    reason: "Engineering work detected in instruction",
  },
  {
    phrases: ["roadmap", "priorit", "stakeholder", "spec", "requirements", "launch plan", "approval"],
    userID: "user-alice",
    reason: "Product decision detected in instruction",
  },
  {
    phrases: ["architecture", "infra", "on-call", "incident", "eng lead", "system design"],
    userID: "user-dana",
    reason: "Engineering leadership scope detected",
  },
];

function matchTeamRoute(text, senderID) {
  const lower = String(text || "").toLowerCase();
  for (const route of TEAM_ROUTES) {
    if (route.userID === senderID) continue;
    if (route.phrases.some((phrase) => lower.includes(phrase))) {
      return route;
    }
  }
  return null;
}

function matchRoleRoute(text, senderID) {
  const lower = String(text || "").toLowerCase();
  for (const route of ROLE_ROUTES) {
    if (route.userID === senderID) continue;
    if (route.phrases.some((phrase) => lower.includes(phrase))) {
      return route;
    }
  }
  return null;
}

export function resolveRecipientTarget(text, senderID, organization) {
  const lower = String(text || "").toLowerCase();

  for (const userID of DEMO_USER_IDS) {
    if (userID === senderID) continue;
    const name = userNameFor(userID).toLowerCase();
    if (lower.includes(name)) {
      return {
        recipientUserID: userID,
        routingReason: "Named in your instruction",
        forceOverride: true,
      };
    }
  }

  const team = matchTeamRoute(text, senderID);
  if (team) {
    return {
      recipientUserID: team.userID,
      routingReason: `Routed to ${team.label} team · ${userNameFor(team.userID)}`,
      forceOverride: true,
    };
  }

  const role = matchRoleRoute(text, senderID);
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

  const fallback = DEMO_USER_IDS.find((userID) => userID !== senderID) || senderID;
  return {
    recipientUserID: fallback,
    routingReason: "Best match for this decision in org graph",
    forceOverride: false,
  };
}

export const AGENT_TOOLS = [
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
            enum: DEMO_USER_IDS,
            description:
              "Who should receive and act on this decision. Route by team/role: design→user-carol, engineering/dev/bugs→user-bob or user-dana, product/PM→user-alice",
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

const SYSTEM_PROMPT = `You route workplace instructions to the right teammate as structured Decision Cards.

Call create_decision_card once with all fields filled:
- Never echo the sender's exact wording in title or summary
- title: 3-8 words, action-oriented
- summary: third person, what the recipient must decide or do
- context: deadlines, metrics, PR numbers, blockers — always 2-4 segments as 'label: detail' joined by ·
- priority: infer from urgency cues in the instruction
- Pick recipient from org graph using team, role, and manager edges

Team routing (critical):
- design team / design / UX / UI → user-carol (Carol, Designer)
- engineering / dev / bugs / APIs → user-bob (Bob, Engineer) or user-dana (Dana, Eng Lead) for leadership
- product / PM / roadmap / approvals → user-alice (Alice, Product Manager)
- named person in instruction → that person
- "manager" → sender's manager from org edges`;

export function buildUserPrompt({ text, sender, organization }) {
  const orgContext = organizationContext(organization);
  return `Sender: ${sender.name} (${sender.id}, ${sender.role})
Instruction: ${text}

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
  if (userID === "user-alice") return "Alice";
  if (userID === "user-bob") return "Bob";
  if (userID === "user-carol") return "Carol";
  if (userID === "user-dana") return "Dana";
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
  const allowedRecipients = new Set(DEMO_USER_IDS);
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
  attempt = 0,
}) {
  const userPrompt = buildUserPrompt({ text, sender, organization });

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openRouter.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": openRouter.appUrl,
      "X-Title": openRouter.appName,
    },
    body: JSON.stringify({
      model: openRouter.model,
      temperature: 0.2,
      max_tokens: 512,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      tools: AGENT_TOOLS,
      tool_choice: {
        type: "function",
        function: { name: "create_decision_card" },
      },
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    const message = data?.error?.message || "OpenRouter request failed.";
    throw new Error(message);
  }

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
        attempt: attempt + 1,
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
        detail: `${userNameFor(routingJSON.recipientUserID)} · ${routingJSON.cardType}`,
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
}) {
  if (openRouter?.apiKey) {
    try {
      return await routeInstructionWithOpenRouter({
        text,
        sender,
        organization,
        priorityOverride,
        openRouter,
      });
    } catch (error) {
      console.warn("AI routing failed, using local fallback:", error.message);
    }
  }

  return routeInstructionLocally({ text, sender, organization, priorityOverride });
}

const REFINE_TOOL = [
  {
    type: "function",
    function: {
      name: "refine_decision_card",
      description:
        "Apply the card owner's follow-up instruction to an existing decision card. Only include fields the instruction actually changes; everything else stays as-is.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Updated title, only if the instruction changes what the decision is about",
          },
          summary: {
            type: "string",
            description: "Updated summary, only if the instruction changes it",
          },
          addContext: {
            type: "string",
            description:
              "New facts to append to context as 'label: detail' segments joined by · e.g. 'deadline: Friday · blocker: waiting on QA'",
          },
          priority: {
            type: "string",
            enum: ["low", "medium", "high", "urgent"],
            description: "Only when the instruction signals urgency or de-prioritization",
          },
          note: {
            type: "string",
            description: "One short sentence describing what changed",
          },
        },
        required: ["note"],
        additionalProperties: false,
      },
    },
  },
];

const REFINE_SYSTEM_PROMPT = `You maintain an existing workplace Decision Card. The card's owner gives you a follow-up instruction about it.

Call refine_decision_card once:
- Only include fields the instruction actually changes
- addContext: new facts as 'label: detail' segments joined by ·
- priority: only when the instruction signals urgency or de-prioritization
- note: one short sentence describing the change
Never replace the card's content with the owner's raw words.`;

function mergeRefinement(card, args, toolCalls) {
  const allowedPriorities = new Set(["low", "medium", "high", "urgent"]);
  const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : card.title;
  const summary =
    typeof args.summary === "string" && args.summary.trim() ? args.summary.trim() : card.summary;
  const priority = allowedPriorities.has(args.priority) ? args.priority : card.priority;

  let context = String(card.context || "");
  const addition = typeof args.addContext === "string" ? args.addContext.trim() : "";
  if (addition) {
    context = [context, addition].filter(Boolean).join(" · ");
  }

  return { title, summary, context, priority, toolCalls };
}

export function refineCardLocally({ card, instruction }) {
  const lower = String(instruction || "").toLowerCase();
  let priority = null;
  if (/(low priority|not urgent|no rush|later|whenever|backlog|deprioritize)/.test(lower)) {
    priority = "low";
  } else if (/(urgent|asap|immediately|right away|today|critical)/.test(lower)) {
    priority = "urgent";
  } else if (/(high priority|important|prioritize|bump)/.test(lower)) {
    priority = "high";
  }

  const cleaned = String(instruction || "").replace(/\s+/g, " ").trim();
  const toolCalls = [];
  if (cleaned) {
    toolCalls.push({ name: "add_context", label: "Add note", detail: cleaned.slice(0, 60) });
  }
  if (priority) {
    toolCalls.push({ name: "set_priority", label: "Set priority", detail: priority });
  }

  return mergeRefinement(
    card,
    { addContext: cleaned ? `note: ${cleaned}` : "", priority },
    toolCalls
  );
}

async function refineCardWithOpenRouter({ card, instruction, openRouter }) {
  const userPrompt = `Card:
- title: ${card.title}
- summary: ${card.summary}
- context: ${card.context || "(none)"}
- priority: ${card.priority}
- type: ${card.cardType || card.type || "task"}

Owner's follow-up instruction: ${instruction}`;

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openRouter.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": openRouter.appUrl,
      "X-Title": openRouter.appName,
    },
    body: JSON.stringify({
      model: openRouter.model,
      temperature: 0.2,
      max_tokens: 512,
      messages: [
        { role: "system", content: REFINE_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      tools: REFINE_TOOL,
      tool_choice: {
        type: "function",
        function: { name: "refine_decision_card" },
      },
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    const message = data?.error?.message || "OpenRouter request failed.";
    throw new Error(message);
  }

  const toolCalls = data?.choices?.[0]?.message?.tool_calls;
  const call = (toolCalls || []).find(
    (item) => item.function?.name === "refine_decision_card"
  );
  if (!call) {
    return refineCardLocally({ card, instruction });
  }

  const args = parseToolArguments(call.function?.arguments);
  const steps = [];
  if (args.title && args.title !== card.title) {
    steps.push({ name: "create_decision_card", label: "Rewrite title", detail: args.title });
  }
  if (args.summary && args.summary !== card.summary) {
    steps.push({ name: "create_decision_card", label: "Rewrite summary", detail: args.summary.slice(0, 60) });
  }
  if (args.addContext) {
    steps.push({ name: "add_context", label: "Add context", detail: args.addContext.slice(0, 60) });
  }
  if (args.priority && args.priority !== card.priority) {
    steps.push({ name: "set_priority", label: "Set priority", detail: args.priority });
  }
  if (steps.length === 0 && args.note) {
    steps.push({ name: "add_context", label: "Reviewed", detail: String(args.note).slice(0, 60) });
  }

  return mergeRefinement(card, args, steps);
}

export async function refineCard({ card, instruction, openRouter }) {
  if (openRouter?.apiKey) {
    try {
      return await refineCardWithOpenRouter({ card, instruction, openRouter });
    } catch (error) {
      console.warn("AI refine failed, using local fallback:", error.message);
    }
  }

  return refineCardLocally({ card, instruction });
}

export { SYSTEM_PROMPT, userNameFor };
