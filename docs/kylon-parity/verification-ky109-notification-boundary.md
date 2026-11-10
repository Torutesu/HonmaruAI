# KY-109 — Agent progress notification boundary

- The Worker regression drives an inline Agent turn through the channel message route using a mocked OpenAI Responses provider and a mocked Relay.
- It asserts that the agent and done progress events are transient channel_ai_progress events, not requester notifications.
- It then asserts the completed answer produces exactly one message_for_you event, one requester push-queue row, and a persisted final Agent message matching the attention event ID.
- Focused Worker suites (agents.test.js, pushes.test.js): 65/65 passed on the prior exact PR head. The full exact-head CI on the new restacked commit is the merge gate.
- No live provider call or real push was made. Multi-user device delivery and every external Agent runtime remain unverified; KY-109 remains partial.
- Simple mode and billing paths are not changed.
