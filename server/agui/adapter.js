// See README.md in this directory: one implementation, in worker/src/agui/.
export * from "../../worker/src/agui/adapter.js";

import { stateSnapshot } from "../../worker/src/agui/events.js";

/// Empty every client's card list.
///
/// Only this relay has it. On the Worker `clear_store` is a no-op that exists
/// solely so TestFlight builds still sending it do not error: it used to run
/// DELETE FROM cards for a whole organization, and the app sent it on every
/// sign-out. Here it stays real, because this relay's store is in memory and
/// clearing it is a local concern.
export function clearEvents() {
  return [stateSnapshot({ cardsById: {} })];
}
