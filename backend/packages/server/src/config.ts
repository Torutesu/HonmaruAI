export interface Config {
  port: number;
  databasePath: string;
  logLevel: string;
  sessionTtlDays: number;
  authDevMode: boolean;
  // Optional bridge: every notification is POSTed here (push provider
  // relay, ntfy, Slack webhook, ...).
  notifyWebhookUrl: string | null;
  // Seconds between SLA sweeps (overdue escalation). 0 disables the timer.
  slaSweepSeconds: number;
  github: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  };
  openRouter: {
    apiKey: string;
    model: string;
    appName: string;
    appUrl: string;
  } | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT || 8081),
    databasePath: env.DATABASE_PATH || "data/honmaru.db",
    logLevel: env.LOG_LEVEL || "info",
    sessionTtlDays: Number(env.SESSION_TTL_DAYS || 30),
    authDevMode: env.AUTH_DEV_MODE === "1",
    notifyWebhookUrl: env.NOTIFY_WEBHOOK_URL || null,
    slaSweepSeconds: Number(env.SLA_SWEEP_SECONDS ?? 60),
    github: {
      clientId: env.GITHUB_CLIENT_ID || "",
      clientSecret: env.GITHUB_CLIENT_SECRET || "",
      redirectUri: env.GITHUB_REDIRECT_URI || "tiktokforwork://oauth/callback",
    },
    openRouter: env.OPENROUTER_API_KEY
      ? {
          apiKey: env.OPENROUTER_API_KEY,
          model: env.OPENROUTER_MODEL || "inclusionai/ling-3.0-flash:free",
          appName: env.OPENROUTER_APP_NAME || "HonmaruAI",
          appUrl: env.OPENROUTER_APP_URL || "http://localhost:8081",
        }
      : null,
  };
}
