import { createHash } from "node:crypto";
import type { User } from "@honmaru/protocol";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { newId, newSecret, now } from "./ids.js";

export class AuthError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

interface UserRow {
  id: string;
  name: string;
  github_user_id: number | null;
  github_username: string | null;
  avatar_url: string | null;
  created_at: string;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    name: row.name,
    githubUsername: row.github_username,
    avatarUrl: row.avatar_url,
    createdAt: row.created_at,
  };
}

export function createSession(db: Db, userId: string, ttlDays: number): string {
  const token = newSecret();
  const expiresAt = new Date(
    Date.now() + ttlDays * 24 * 60 * 60 * 1000
  ).toISOString();
  db.prepare(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).run(hashToken(token), userId, now(), expiresAt);
  return token;
}

export function authenticate(db: Db, token: string): User | null {
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`
    )
    .get(hashToken(token), now()) as UserRow | undefined;
  return row ? toUser(row) : null;
}

export function getUser(db: Db, userId: string): User | null {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as
    | UserRow
    | undefined;
  return row ? toUser(row) : null;
}

export function devLogin(db: Db, name: string): User {
  const user: User = {
    id: newId("usr"),
    name,
    githubUsername: null,
    avatarUrl: null,
    createdAt: now(),
  };
  db.prepare(
    "INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)"
  ).run(user.id, user.name, user.createdAt);
  return user;
}

interface GitHubProfile {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
}

export async function exchangeGitHubCode(
  config: Config,
  code: string
): Promise<{ accessToken: string; profile: GitHubProfile }> {
  const { clientId, clientSecret, redirectUri } = config.github;
  if (!clientId || !clientSecret) {
    throw new AuthError("oauth_not_configured", "GitHub OAuth is not configured.");
  }

  const tokenResponse = await fetch(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    }
  );
  const tokenData = (await tokenResponse.json()) as Record<string, string>;
  if (!tokenResponse.ok || tokenData.error || !tokenData.access_token) {
    throw new AuthError(
      "oauth_exchange_failed",
      tokenData.error_description || tokenData.error || "OAuth exchange failed."
    );
  }

  const profileResponse = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!profileResponse.ok) {
    throw new AuthError("oauth_profile_failed", "Could not load GitHub profile.");
  }
  const profile = (await profileResponse.json()) as GitHubProfile;
  return { accessToken: tokenData.access_token, profile };
}

export function upsertGitHubUser(db: Db, profile: GitHubProfile): User {
  const existing = db
    .prepare("SELECT * FROM users WHERE github_user_id = ?")
    .get(profile.id) as UserRow | undefined;

  const name = profile.name || profile.login;
  if (existing) {
    db.prepare(
      "UPDATE users SET name = ?, github_username = ?, avatar_url = ? WHERE id = ?"
    ).run(name, profile.login, profile.avatar_url, existing.id);
    return toUser({
      ...existing,
      name,
      github_username: profile.login,
      avatar_url: profile.avatar_url,
    });
  }

  const user: User = {
    id: newId("usr"),
    name,
    githubUsername: profile.login,
    avatarUrl: profile.avatar_url,
    createdAt: now(),
  };
  db.prepare(
    `INSERT INTO users (id, name, github_user_id, github_username, avatar_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    user.id,
    user.name,
    profile.id,
    profile.login,
    profile.avatar_url,
    user.createdAt
  );
  return user;
}
