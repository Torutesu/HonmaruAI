import { gmail } from "./gmail.js";
import { slack } from "./slack.js";
import { notion } from "./notion.js";

// Adding a source means writing one module and adding it here. Nothing in the
// sync loop, the API or the client knows which connectors exist.
export const CONNECTORS = [gmail, slack, notion];

export function connectorById(id) {
  return CONNECTORS.find((c) => c.id === id) || null;
}
