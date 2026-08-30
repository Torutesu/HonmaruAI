// See README.md in this directory: one implementation, in worker/src/agui/.
//
// The shared module calls the global `crypto.randomUUID()`, which Node has had
// since 19. This relay therefore needs Node 19 or newer — recorded in
// package.json's `engines` so the failure is a clear one rather than
// "crypto is not defined".
export * from "../../worker/src/agui/events.js";
