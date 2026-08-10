import { gmail } from "./gmail.js";
import { slack } from "./slack.js";

// Adding a source means writing one module and adding it here. Nothing in the
// sync loop, the API or the client knows which connectors exist.
export const CONNECTORS = [gmail, slack];

export function connectorById(id) {
  return CONNECTORS.find((c) => c.id === id) || null;
}
