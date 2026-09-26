# ShogunAI emoji

24 animated SVGs (128×128), for the ShogunAI workspace only. They are not
built into the app: a workspace's emoji belong to that workspace.

To add them to the ShogunAI workspace, either:

- In the app: **Studio → Emoji → Choose files**, select all 24, then **Add 24**.
- From here, with a session of a ShogunAI member:

  ```sh
  HONMARU_SESSION=<token> node worker/scripts/add-emoji.mjs --api <worker url> --org <ShogunAI orgId> assets/emoji/shogunai
  ```

Use them as `:shogun_party:`, `:shogun_lgtm:` and so on.
