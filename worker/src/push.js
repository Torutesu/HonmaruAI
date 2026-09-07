// The APNs channel used to live here as `notifyCard`. It is now one of three
// channels behind `notify.js`, which is where the alert is composed — in the
// recipient's language — and where email steps in when no push arrives. This
// re-export keeps the old import path working for anything that still uses it.
export { notifyCard } from "./notify.js";
