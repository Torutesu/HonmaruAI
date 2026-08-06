import type { Config } from "../src/config.js";

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    databasePath: ":memory:",
    logLevel: "silent",
    sessionTtlDays: 30,
    authDevMode: true,
    github: { clientId: "", clientSecret: "", redirectUri: "" },
    openRouter: null,
    ...overrides,
  };
}
