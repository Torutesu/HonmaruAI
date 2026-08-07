import {
  CardPriority,
  CardType,
  type Member,
  type OrgEdge,
  type Team,
} from "@honmaru/protocol";
import { z } from "zod";
import type { Config } from "./config.js";

// ---------------------------------------------------------------------------
// Routing: turn a free-text instruction into a structured decision card
// addressed to the right org member. LLM first (OpenRouter tool call),
// deterministic keyword fallback second. Both paths are driven entirely by
// org data — there are no hardcoded users.
// ---------------------------------------------------------------------------

export interface RoutingInput {
  text: string;
  sender: Member;
  members: Member[];
  teams: Team[];
  edges: OrgEdge[];
  priorityOverride?: CardPriority;
  // Agent-memory block ("What each person's AI has learned: …"),
  // injected into the LLM prompt to personalize routing and card copy.
  memoryContext?: string;
}

export const RoutingResult = z.object({
  recipientUserId: z.string(),
  cardType: CardType,
  title: z.string().min(1),
  summary: z.string().min(1),
  context: z.string().min(1),
  priority: CardPriority,
  routingReason: z.string().min(1),
  labels: z.array(z.string()).default([]),
  agentRoute: z.string(),
});
export type RoutingResult = z.infer<typeof RoutingResult>;

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

function managerOfSender(input: RoutingInput): Member | null {
  const edge = input.edges.find(
    (item) => item.kind === "manages" && item.toId === input.sender.userId
  );
  if (!edge) return null;
  return input.members.find((member) => member.userId === edge.fromId) ?? null;
}

function candidates(input: RoutingInput): Member[] {
  return input.members.filter(
    (member) => member.userId !== input.sender.userId
  );
}

// --- deterministic fallback -------------------------------------------------

function resolveRecipientLocally(input: RoutingInput): {
  recipient: Member;
  reason: string;
} {
  const lower = input.text.toLowerCase();
  const others = candidates(input);
  if (others.length === 0) {
    return { recipient: input.sender, reason: "Routed to you (solo org)" };
  }

  // 1. Named person wins.
  for (const member of others) {
    if (lower.includes(firstName(member.name).toLowerCase())) {
      return { recipient: member, reason: "Named in your instruction" };
    }
  }

  // 2. Team name mentioned -> first member of that team.
  for (const team of input.teams) {
    if (lower.includes(team.name.toLowerCase())) {
      const member = others.find((item) => item.teamId === team.id);
      if (member) {
        return {
          recipient: member,
          reason: `Routed to ${team.name} team · ${member.name}`,
        };
      }
    }
  }

  // 3. Job-title keyword overlap ("fix the API" -> title contains engineer, etc.)
  const scored = others
    .map((member) => {
      const words = member.title
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length >= 3);
      const score = words.filter((word) => lower.includes(word)).length;
      return { member, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored[0]) {
    return {
      recipient: scored[0].member,
      reason: `${scored[0].member.title} scope detected in instruction`,
    };
  }

  // 4. Explicit "manager", or escalate to sender's manager by default.
  const manager = managerOfSender(input);
  if (manager) {
    return {
      recipient: manager,
      reason: lower.includes("manager")
        ? `${manager.name} is your manager`
        : `Escalated to ${manager.name}`,
    };
  }

  return {
    recipient: others[0]!,
    reason: "Best match for this decision in org graph",
  };
}

function inferCardType(text: string): CardType {
  const lower = text.toLowerCase();
  if (lower.includes("approv")) return "approval";
  if (lower.includes("delegate") || lower.includes("assign")) return "delegation";
  if (lower.includes("revise") || lower.includes("feedback")) return "revision";
  if (lower.includes("task") || lower.includes("fix") || lower.includes("build")) {
    return "task";
  }
  return "notification";
}

function inferPriority(text: string): CardPriority {
  const lower = text.toLowerCase();
  if (lower.includes("urgent") || lower.includes("asap")) return "urgent";
  if (lower.includes("whenever") || lower.includes("low priority")) return "low";
  return "high";
}

function summarize(
  text: string,
  input: RoutingInput,
  cardType: CardType,
  recipient: Member
): { title: string; summary: string; context: string } {
  const names = input.members.map((member) => firstName(member.name)).join("|");
  let cleaned = text.trim();
  cleaned = cleaned.replace(
    new RegExp(
      `^(please\\s+)?(tell|ask|notify|send|ping|remind)\\s+(${names}|manager)\\s+(to\\s+)?`,
      "i"
    ),
    ""
  );
  cleaned = cleaned.replace(/^(can you|could you|hey|hi|yo)\s+/i, "");
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }

  const titles: Record<CardType, string> = {
    approval: "Approval needed",
    delegation: `Task for ${firstName(recipient.name)}`,
    revision: "Revision requested",
    task: cleaned.split(" ").slice(0, 6).join(" ").slice(0, 48) || "New task",
    notification: `Update for ${firstName(recipient.name)}`,
  };

  return {
    title: titles[cardType],
    summary:
      cleaned.length > 180 ? `${cleaned.slice(0, 177).trim()}…` : cleaned || "Decision requested.",
    context: `From ${input.sender.name} · decision routed to ${recipient.name}`,
  };
}

export function routeLocally(input: RoutingInput): RoutingResult {
  const { recipient, reason } = resolveRecipientLocally(input);
  const cardType = inferCardType(input.text);
  const rewritten = summarize(input.text, input, cardType, recipient);
  return RoutingResult.parse({
    recipientUserId: recipient.userId,
    cardType,
    title: rewritten.title,
    summary: rewritten.summary,
    context: rewritten.context,
    priority: input.priorityOverride ?? inferPriority(input.text),
    routingReason: reason,
    labels: [],
    agentRoute: `${firstName(input.sender.name)}'s AI → ${firstName(recipient.name)}'s AI`,
  });
}

// --- LLM path ---------------------------------------------------------------

function buildTool(input: RoutingInput) {
  const memberIds = candidates(input).map((member) => member.userId);
  return {
    type: "function",
    function: {
      name: "create_decision_card",
      description:
        "Turn a messy workplace instruction into a structured decision card routed to the right teammate. Rewrite the sender's words — never echo them.",
      parameters: {
        type: "object",
        properties: {
          recipientUserId: {
            type: "string",
            enum: memberIds.length > 0 ? memberIds : [input.sender.userId],
          },
          cardType: {
            type: "string",
            enum: ["approval", "delegation", "notification", "task", "revision"],
          },
          title: { type: "string", description: "3-8 words, action-oriented" },
          summary: {
            type: "string",
            description: "1-2 sentences, third person, what the recipient must decide or do",
          },
          context: {
            type: "string",
            description:
              "2-4 structured facts as 'label: detail' segments separated by ·",
          },
          priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
          routingReason: {
            type: "string",
            description: "One sentence: why this person owns the decision",
          },
          labels: { type: "array", items: { type: "string" } },
        },
        required: [
          "recipientUserId",
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
  };
}

export function rosterPrompt(input: RoutingInput): string {
  const teamName = (teamId: string | null | undefined) =>
    input.teams.find((team) => team.id === teamId)?.name;
  const memberLines = input.members
    .map((member) => {
      const team = teamName(member.teamId);
      return `- ${member.userId}: ${member.name}, ${member.title}${team ? ` (${team} team)` : ""}`;
    })
    .join("\n");
  const nameOf = (id: string) =>
    input.members.find((member) => member.userId === id)?.name ?? id;
  const edgeLines = input.edges
    .map((edge) => `- ${nameOf(edge.fromId)} ${edge.kind} ${nameOf(edge.toId)}`)
    .join("\n");
  return `Sender: ${input.sender.name} (${input.sender.userId}, ${input.sender.title})
Instruction: ${input.text}

Org members:
${memberLines}

Org edges:
${edgeLines || "- none"}${input.memoryContext ? `\n\n${input.memoryContext}` : ""}`;
}

const SYSTEM_PROMPT = `You route workplace instructions to the right teammate as structured Decision Cards.

Call create_decision_card once with all fields filled:
- Never echo the sender's exact wording in title or summary
- title: 3-8 words, action-oriented
- summary: third person, what the recipient must decide or do
- context: deadlines, metrics, PR numbers, blockers — always 2-4 segments as 'label: detail' joined by ·
- priority: infer from urgency cues in the instruction
- Pick the recipient from the org members list using name mentions, job titles, team names, and manager edges. Never route back to the sender.
- If a "What each person's AI has learned" section is present, use it: route around known objections, and include the context that person usually asks for (e.g. attach repro steps for someone who always requests them).`;

function isEcho(candidate: string, original: string): boolean {
  const normalize = (value: string) =>
    value.trim().toLowerCase().replace(/\s+/g, " ");
  const a = normalize(candidate);
  const b = normalize(original);
  if (!a || !b) return false;
  return (
    a === b ||
    (a.length >= b.length * 0.75 && b.includes(a)) ||
    (b.length >= a.length * 0.75 && a.includes(b))
  );
}

export async function routeInstruction(
  input: RoutingInput,
  openRouter: Config["openRouter"],
  log?: { warn: (obj: unknown, msg?: string) => void }
): Promise<RoutingResult> {
  if (!openRouter) {
    return routeLocally(input);
  }
  try {
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
          { role: "user", content: rosterPrompt(input) },
        ],
        tools: [buildTool(input)],
        tool_choice: {
          type: "function",
          function: { name: "create_decision_card" },
        },
      }),
    });
    const data = (await response.json()) as {
      error?: { message?: string };
      choices?: { message?: { tool_calls?: { function?: { name?: string; arguments?: string } }[] } }[];
    };
    if (!response.ok) {
      throw new Error(data?.error?.message || "OpenRouter request failed.");
    }
    const call = data.choices?.[0]?.message?.tool_calls?.find(
      (item) => item.function?.name === "create_decision_card"
    );
    if (!call?.function?.arguments) {
      throw new Error("Model did not call create_decision_card.");
    }
    const args = JSON.parse(call.function.arguments) as Record<string, unknown>;

    const recipient = input.members.find(
      (member) =>
        member.userId === args.recipientUserId &&
        member.userId !== input.sender.userId
    );
    if (!recipient) {
      throw new Error("Model picked an invalid recipient.");
    }

    let result = RoutingResult.parse({
      ...args,
      priority: input.priorityOverride ?? args.priority,
      agentRoute: `${firstName(input.sender.name)}'s AI → ${firstName(recipient.name)}'s AI`,
    });

    if (isEcho(result.summary, input.text) || isEcho(result.title, input.text)) {
      const rewritten = summarize(input.text, input, result.cardType, recipient);
      result = { ...result, ...rewritten };
    }
    return result;
  } catch (error) {
    log?.warn({ err: error }, "AI routing failed; using local fallback");
    return routeLocally(input);
  }
}
