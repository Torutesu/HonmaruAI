/** @typedef {{ recipientUserID: string, cardType: string, title: string, summary: string, context: string, priority: string, routingReason: string, agentRoute?: string, labels?: string[] }} DecisionCardArgs */
/** @typedef {{ id: string, name: string, role: string, githubUsername?: string, managerID?: string|null }} Member */

/**
 * Role categories used to route by team/role instead of by hard-coded people.
 * `rolePatterns` match against a member's role string, `phrases` against the instruction text.
 */
const ROLE_CATEGORIES = [
  {
    key: "design",
    label: "Design",
    rolePatterns: [/design/i, /\bux\b/i, /\bui\b/i, /brand/i],
    teamPhrases: ["design team", "designers", "designer", "design dept"],
    phrases: [
      "mockup",
      "figma",
      "pixel",
      "spacing",
      "empty state",
      "visual",
      "ui ",
      "ux ",
      "design system",
      "copy pass",
    ],
    reason: "Design work detected in instruction",
  },
  {
    key: "engineering",
    label: "Engineering",
    rolePatterns: [/engineer/i, /developer/i, /\bdev\b/i, /\bcto\b/i, /\bsre\b/i, /tech lead/i],
    teamPhrases: ["engineering team", "eng team", "engineers", "dev team", "developers", "engineering"],
    phrases: [
      "bug",
      "fix",
      "api",
      "deploy",
      "latency",
      "hotfix",
      "backend",
      "auth",
      "endpoint",
      "pr #",
      "merge",
      "regression",
      "architecture",
      "infra",
      "on-call",
      "incident",
      "system design",
    ],
    reason: "Engineering work detected in instruction",
  },
  {
    key: "product",
    label: "Product",
    rolePatterns: [/product/i, /\bpm\b/i, /program manager/i],
    teamPhrases: ["product team", "product managers", "pm team", "product manager"],
    phrases: ["roadmap", "priorit", "stakeholder", "spec", "requirements", "launch plan", "backlog"],
    reason: "Product decision detected in instruction",
  },
  {
    key: "leadership",
    label: "Leadership",
    rolePatterns: [/\bceo\b/i, /founder/i, /chief/i, /\bhead\b/i, /\bvp\b/i, /director/i, /lead/i],
    teamPhrases: ["leadership", "exec", "execs", "executive team", "management"],
    phrases: ["budget", "hiring", "headcount", "fundraise", "investor", "company-wide", "strategy", "approval"],
    reason: "Leadership decision detected in instruction",
  },
];

const CARD_TYPES = ["approval", "delegation", "notification", "task", "revision"];
const PRIORITIES = ["low", "medium", "high", "urgent"];

/**
 * Wraps the live member roster so routing never depends on hard-coded people.
 * @param {Member[]} members
 */
export function createDirectory(members) {
  const list = (Array.isArray(members) ? members : []).filter(
    (member) => member && typeof member.id === "string" && member.id && member.name
  );

  const nameFor = (userID) => list.find((member) => member.id === userID)?.name || userID;
  const roleFor = (userID) => list.find((member) => member.id === userID)?.role || "";

  const categoryFor = (member) => {
    const role = String(member?.role || "");
    return ROLE_CATEGORIES.find((category) =>
      category.rolePatterns.some((pattern) => pattern.test(role))
    )?.key;
  };

  const membersInCategory = (key, excludeID) =>
    list.filter((member) => member.id !== excludeID && categoryFor(member) === key);

  return {
    members: list,
    ids: list.map((member) => member.id),
    isEmpty: list.length === 0,
    has: (userID) => list.some((member) => member.id === userID),
    nameFor,
    roleFor,
    categoryFor,
    membersInCategory,
    others: (excludeID) => list.filter((member) => member.id !== excludeID),
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchNamedPerson(text, senderID, directory) {
  const lower = String(text || "").toLowerCase();
  for (const member of directory.others(senderID)) {
    const name = member.name.toLowerCase();
    if (!name) continue;
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(name)}([^\\p{L}\\p{N}]|$)`, "iu");
    if (pattern.test(lower)) {
      return member;
    }
  }
  return null;
}

function matchCategory(text, senderID, directory, field) {
  const lower = String(text || "").toLowerCase();
  for (const category of ROLE_CATEGORIES) {
    const phrases = category[field] || [];
    if (!phrases.some((phrase) => lower.includes(phrase))) continue;
    const candidate = directory.membersInCategory(category.key, senderID)[0];
    if (candidate) {
      return { category, member: candidate };
    }
  }
  return null;
}

/**
 * Decide who a raw instruction belongs to, using the live roster and org edges.
 * @param {string} text
 * @param {string} senderID
 * @param {object} organization
 * @param {ReturnType<typeof createDirectory>} directory
 */
export function resolveRecipientTarget(text, senderID, organization, directory) {
  const lower = String(text || "").toLowerCase();

  const named = matchNamedPerson(text, senderID, directory);
  if (named) {
    return {
      recipientUserID: named.id,
      routingReason: "Named in your instruction",
      forceOverride: true,
    };
  }

  const team = matchCategory(text, senderID, directory, "teamPhrases");
  if (team) {
    return {
      recipientUserID: team.member.id,
      routingReason: `Routed to ${team.category.label} · ${team.member.name}`,
      forceOverride: true,
    };
  }

  const role = matchCategory(text, senderID, directory, "phrases");
  if (role) {
    return {
      recipientUserID: role.member.id,
      routingReason: role.category.reason,
      forceOverride: true,
    };
  }

  if (lower.includes("manager")) {
    const edge = organization?.edges?.find(
      (item) => item.toID === senderID && item.kind === "manages"
    );
    if (edge?.fromID && directory.has(edge.fromID)) {
      return {
        recipientUserID: edge.fromID,
        routingReason: `You are ${directory.nameFor(senderID)}'s manager`,
        forceOverride: true,
      };
    }
  }

  const managerEdge = organization?.edges?.find(
    (item) => item.toID === senderID && item.kind === "manages"
  );
  if (managerEdge?.fromID && managerEdge.fromID !== senderID && directory.has(managerEdge.fromID)) {
    return {
      recipientUserID: managerEdge.fromID,
      routingReason: `Escalated to ${directory.nameFor(managerEdge.fromID)}`,
      forceOverride: false,
    };
  }

  const leader = directory.membersInCategory("leadership", senderID)[0];
  const fallback = leader?.id || directory.others(senderID)[0]?.id || senderID;
  return {
    recipientUserID: fallback,
    routingReason: "Best match for this decision in org graph",
    forceOverride: false,
  };
}

/**
 * The recipient enum is built per request so newly added members are routable immediately.
 * @param {ReturnType<typeof createDirectory>} directory
 */
export function buildAgentTools(directory) {
  const routingHint = directory.members
    .map((member) => `${member.id} (${member.name}, ${member.role})`)
    .join("; ");

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
              enum: directory.ids,
              description: `Who should receive and act on this decision. Members: ${routingHint}`,
            },
            cardType: {
              type: "string",
              enum: CARD_TYPES,
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
              enum: PRIORITIES,
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
        description: "Override the card priority when urgency cues are explicit",
        parameters: {
          type: "object",
          properties: {
            level: { type: "string", enum: PRIORITIES },
            reason: { type: "string" },
          },
          required: ["level"],
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

/**
 * @param {ReturnType<typeof createDirectory>} directory
 */
export function buildSystemPrompt(directory) {
  const roster = directory.members
    .map((member) => `- ${member.id}: ${member.name}, ${member.role}`)
    .join("\n");

  return `You route workplace instructions to the right teammate as structured Decision Cards.

Call create_decision_card once with all fields filled:
- Never echo the sender's exact wording in title or summary
- title: 3-8 words, action-oriented
- summary: third person, what the recipient must decide or do
- context: deadlines, metrics, PR numbers, blockers — always 2-4 segments as 'label: detail' joined by ·
- priority: infer from urgency cues in the instruction
- Pick recipient from the roster below using role, team, and manager edges

Roster:
${roster || "- (no members)"}

Routing rules (critical):
- A person named in the instruction wins over everything else
- Otherwise match the work to the role: design work → a designer, engineering work → an engineer,
  product/roadmap work → a product role, budget/hiring/strategy → the CEO or a lead
- "manager" → the sender's manager from the org edges
- Never route back to the sender unless nobody else can own it`;
}

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

function parseToolArguments(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  return JSON.parse(raw);
}

/**
 * @param {import('openai').ChatCompletionMessageToolCall[] | undefined} toolCalls
 * @param {string} senderName
 * @param {ReturnType<typeof createDirectory>} directory
 */
export function materializeFromToolCalls(toolCalls, senderName, directory) {
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
        detail: `${directory.nameFor(args.recipientUserID)} · ${args.cardType}`,
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

  const recipientName = directory.nameFor(card.recipientUserID);
  card.agentRoute = `${senderName}'s AI → ${recipientName}'s AI`;

  return { card, toolCalls: steps };
}

function resolveRecipient(text, senderID, organization, directory) {
  const target = resolveRecipientTarget(text, senderID, organization, directory);
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
  directory,
}) {
  if (routingReason) return routingReason;
  if (namedInInstruction) return "Named in your instruction";
  const managerEdge = organization?.edges?.find(
    (item) => item.toID === senderID && item.kind === "manages"
  );
  if (managerEdge?.fromID === recipientUserID) {
    return `You are ${directory.nameFor(senderID)}'s manager`;
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

function summarizeInstruction(text, { sender, cardType, recipientUserID, directory }) {
  const names = directory.members.map((member) => escapeRegExp(member.name)).join("|");
  const namePattern = names ? `${names}|manager` : "manager";

  let cleaned = String(text || "").trim();
  cleaned = cleaned.replace(
    new RegExp(`^(please\\s+)?(tell|ask|notify|send|ping|remind)\\s+(${namePattern})\\s+(to\\s+)?`, "i"),
    ""
  );
  cleaned = cleaned.replace(/^(can you|could you|hey|hi|yo)\s+/i, "");
  cleaned = cleaned.replace(
    new RegExp(`^(i need|we need)\\s+(${namePattern})\\s+to\\s+`, "i"),
    ""
  );
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }

  const recipientName = directory.nameFor(recipientUserID);
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

function applyRoutingGuard(routing, sender, originalText, organization, directory) {
  const target = resolveRecipientTarget(originalText, sender.id, organization, directory);
  if (!target.forceOverride || target.recipientUserID === routing.recipientUserID) {
    return routing;
  }

  const recipientName = directory.nameFor(target.recipientUserID);
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

function validateRouting(routingJSON, sender, originalText, toolCalls, organization, directory) {
  const allowedTypes = new Set(CARD_TYPES);
  const allowedPriorities = new Set(PRIORITIES);

  const recipientUserID = routingJSON.recipientUserID;
  const cardType = routingJSON.cardType;
  let title = routingJSON.title;
  let summary = routingJSON.summary;
  let context = routingJSON.context;
  const priority = routingJSON.priority;

  if (!directory.has(recipientUserID)) {
    throw new Error("AI picked a recipient who is not in the organization.");
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
      directory,
    });
    title = rewritten.title;
    summary = rewritten.summary;
    context = rewritten.context;
  }

  const recipientName = directory.nameFor(recipientUserID);
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
    organization,
    directory
  );
}

export function routeInstructionLocally({
  text,
  sender,
  organization,
  priorityOverride,
  directory,
}) {
  const lower = String(text || "").toLowerCase();
  const { recipientUserID, namedInInstruction, routingReason } = resolveRecipient(
    text,
    sender.id,
    organization,
    directory
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
    directory,
  });
  const recipientName = directory.nameFor(recipientUserID);
  const priority =
    priorityOverride && PRIORITIES.includes(priorityOverride)
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
        directory,
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
    organization,
    directory
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
  directory,
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
        { role: "system", content: buildSystemPrompt(directory) },
        { role: "user", content: userPrompt },
      ],
      tools: buildAgentTools(directory),
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
    const { card, toolCalls: steps } = materializeFromToolCalls(
      toolCalls,
      sender.name,
      directory
    );
    if (priorityOverride && PRIORITIES.includes(priorityOverride)) {
      card.priority = priorityOverride;
      steps.push({
        name: "set_priority",
        label: "Priority override",
        detail: priorityOverride,
      });
    }
    return validateRouting(card, sender, text, steps, organization, directory);
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
        directory,
        attempt: attempt + 1,
      });
    }
    console.warn("OpenRouter returned empty routing response; using local fallback.");
    return routeInstructionLocally({ text, sender, organization, priorityOverride, directory });
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
        detail: `${directory.nameFor(routingJSON.recipientUserID)} · ${routingJSON.cardType}`,
      },
    ],
    organization,
    directory
  );
  if (priorityOverride) {
    validated.priority = priorityOverride;
  }
  return validated;
}

/**
 * @param {{ text: string, sender: object, organization: object, priorityOverride?: string, openRouter?: object, members: Member[] }} params
 */
export async function routeInstruction({
  text,
  sender,
  organization,
  priorityOverride,
  openRouter,
  members,
}) {
  const directory = createDirectory(members);

  if (!directory.has(sender?.id)) {
    directory.members.push({ id: sender.id, name: sender.name, role: sender.role || "" });
    directory.ids.push(sender.id);
  }

  if (directory.members.length < 2) {
    throw new Error(
      "Add at least one more member to the organization before routing decisions."
    );
  }

  if (openRouter?.apiKey) {
    try {
      return await routeInstructionWithOpenRouter({
        text,
        sender,
        organization,
        priorityOverride,
        openRouter,
        directory,
      });
    } catch (error) {
      console.warn("AI routing failed, using local fallback:", error.message);
    }
  }

  return routeInstructionLocally({ text, sender, organization, priorityOverride, directory });
}
