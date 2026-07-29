/** @typedef {{ recipientUserID: string, cardType: string, title: string, summary: string, context: string, priority: string, routingReason: string, agentRoute?: string, labels?: string[] }} DecisionCardArgs */

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
            enum: ["user-alice", "user-bob"],
            description: "Who should receive and act on this decision",
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
- context: deadlines, metrics, PR numbers, blockers — always 2-4 segments as `label: detail` joined by ·
- priority: infer from urgency cues in the instruction
- Pick recipient from org graph (manager edges, named people, role fit)`;

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

export { SYSTEM_PROMPT, userNameFor };
