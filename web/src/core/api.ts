import type { OrgEdge, OrgNode, User } from "./types";

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

export const api = {
  me: () => request<MeResponse>("/auth/me"),

  selectMember: (userId: string, repository?: string) =>
    request<{ user: User; repository: string | null }>("/auth/session", {
      method: "POST",
      body: JSON.stringify({ userId, ...(repository ? { repository } : {}) }),
    }),

  signOut: () => request<{ ok: true }>("/auth/signout", { method: "POST" }),

  organization: () =>
    request<{ users: User[]; nodes: OrgNode[]; edges: OrgEdge[] }>("/org"),

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
