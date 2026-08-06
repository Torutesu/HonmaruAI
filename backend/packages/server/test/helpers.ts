import type { Config } from "../src/config.js";

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    databasePath: ":memory:",
    logLevel: "silent",
    sessionTtlDays: 30,
    authDevMode: true,
    notifyWebhookUrl: null,
    slaSweepSeconds: 0,
    github: { clientId: "", clientSecret: "", redirectUri: "" },
    openRouter: null,
    ...overrides,
  };
}
