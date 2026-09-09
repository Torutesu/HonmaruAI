import { gmail } from "./gmail.js";
import { slack } from "./slack.js";
import { notion } from "./notion.js";
import { googlecalendar } from "./googlecalendar.js";
import { googledrive } from "./googledrive.js";

// Adding a source means writing one module and adding it here. Nothing in the
// sync loop, the API or the client knows which connectors exist.
export const CONNECTORS = [gmail, slack, notion, googlecalendar, googledrive];

export function connectorById(id) {
  return CONNECTORS.find((c) => c.id === id) || null;
}

/// Which Composio auth config to send someone to.
///
/// Each connector ships the id of the one this project set up, which is what
/// makes a fresh deployment work without any configuration at all. But an auth
/// config belongs to whoever created it, so a different Composio account —
/// anyone self-hosting this — cannot use those ids and has no way to say so.
/// `CONNECTOR_AUTH_GMAIL` and friends are that way: set one and it wins, leave
/// it and the built-in default stands.
export function authConfigFor(env, connector) {
  const named = env?.[`CONNECTOR_AUTH_${String(connector.id).toUpperCase()}`];
  const value = typeof named === "string" ? named.trim() : "";
  return value || connector.authConfigId || null;
}

/// Which Composio tool to call. Same reasoning as the auth config, for a
/// different reason: a toolkit renames a slug and every deployment breaks until
/// someone ships a build. `CONNECTOR_TOOL_GMAIL` and friends make that a
/// secret, not a release.
export function toolSlugFor(env, connector) {
  const named = env?.[`CONNECTOR_TOOL_${String(connector.id).toUpperCase()}`];
  const value = typeof named === "string" ? named.trim() : "";
  return value || connector.toolSlug;
}

/// The connectors this deployment can actually offer. One with no auth config —
/// no built-in id and no CONNECTOR_AUTH_* naming one — has no way to connect,
/// and listing it is a Connect button that fails on press.
export function availableConnectors(env) {
  return CONNECTORS.filter((c) => Boolean(authConfigFor(env, c)));
}
