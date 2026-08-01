import type { DecisionCard, OrganizationGraph, OrgEdge, OrgNode, User } from "./types";

// Same-origin by default: the relay serves this app, so no base URL and no
// CORS. Credentials ride along as the httpOnly session cookie.
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: init.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new ApiError(response.status, data.message || `Request failed (${response.status}).`);
  }
  return data as T;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

export interface MeResponse {
  githubLogin: string | null;
  user: User | null;
  repository: string | null;
  organization: { users?: User[]; nodes: OrgNode[]; edges: OrgEdge[] };
  push: { web: boolean; publicKey: string | null };
}

export type DecisionAction =
  | "approve"
  | "reject"
  | "revise"
  | "acknowledge"
  | "delegate"
  | "priority";

export interface IngestResponse {
  kind: "decision" | "update";
  channel: { id: string; name: string; isNew?: boolean };
  routing?: {
    recipientUserID: string;
    cardType: string;
    title: string;
    summary: string;
    context: string;
    priority: string;
    agentRoute?: string;
    routingReason?: string;
    labels?: string[];
    toolCalls?: { name: string; label: string; detail: string }[];
  };
}

export const api = {
  me: () => request<MeResponse>("/auth/me"),

  // The relay resolves decisions — status transition, note handling, GitHub
  // sync, response card — so every client behaves identically.
  decide: (input: {
    cardId: string;
    action: DecisionAction;
    note?: string;
    delegateToUserID?: string;
    priority?: string;
  }) =>
    request<{ card: DecisionCard; followUps: number }>("/cards/decide", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  ingest: (input: { text: string; sender: User; organization: OrganizationGraph; priorityOverride?: string }) =>
    request<IngestResponse>("/ai/ingest", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  interpretReply: (input: { card: DecisionCard; reply: string; sender: User }) =>
    request<{ action: "approve" | "reject" | "revise" | "question" | "comment"; note: string }>(
      "/ai/reply",
      { method: "POST", body: JSON.stringify(input) }
    ),

  refineCard: (input: { card: DecisionCard; instruction: string }) =>
    request<{
      title: string;
      summary: string;
      context: string;
      priority: string;
      toolCalls?: { name: string; label: string; detail: string }[];
    }>("/ai/refine", { method: "POST", body: JSON.stringify(input) }),

  /** Ops actions the command palette exposes; both are idempotent sweeps. */
  runDigest: () => request<{ digests: number }>("/digest/run", { method: "POST" }),

  runEscalations: () =>
    request<{ escalated: number }>("/escalations/run", { method: "POST" }),

  selectMember: (userId: string, repository?: string) =>
    request<{ user: User; repository: string | null }>("/auth/session", {
      method: "POST",
      body: JSON.stringify({ userId, ...(repository ? { repository } : {}) }),
    }),

  signOut: () => request<{ ok: true }>("/auth/signout", { method: "POST" }),

  organization: () =>
    request<{ users: User[]; nodes: OrgNode[]; edges: OrgEdge[] }>("/org"),

  setLanguage: (userId: string, language: string) =>
    request<{ user: User; organization: { users: User[]; nodes: OrgNode[]; edges: OrgEdge[] } }>(
      "/org/language",
      { method: "POST", body: JSON.stringify({ userId, language }) }
    ),

  addMember: (input: { name: string; role: string; team?: string; language?: string }) =>
    request<{ user: User; organization: { users: User[]; nodes: OrgNode[]; edges: OrgEdge[] } }>(
      "/org/members",
      { method: "POST", body: JSON.stringify(input) }
    ),

  repositories: () =>
    request<{ repositories: { id: number; fullName: string; htmlURL: string }[] }>(
      "/github/repos"
    ),

  selectRepository: (repository: string) =>
    request<{ repository: string }>("/github/repo", {
      method: "POST",
      body: JSON.stringify({ repository }),
    }),

  createIssue: (input: { title: string; body: string; labels?: string[] }) =>
    request<{ number: number; url: string; state: string }>("/github/issues", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  updateIssue: (
    number: number,
    input: { title?: string; body?: string; state?: "open" | "closed" }
  ) =>
    request<{ number: number; url: string; state: string }>(`/github/issues/${number}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
};
