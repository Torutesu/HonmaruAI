# UI / UX redesign review — 2026-09-08

The user rejected the previous interface as unsuitable for a product and explicitly requested a comprehensive redesign of both web and iPhone. This change replaces the request carousel with a searchable queue, readable detail views, an editable send-before-confirm flow, and separate Inbox / Sent / Completed / Workspace destinations.

## Before / After / Why

| Before | After | Why |
|---|---|---|
| One oversized card occupies the mobile viewport; other requests are hidden behind paging. | A list exposes the pending workload; search and type/priority filters narrow it. Desktop keeps list and detail visible together. | Users can identify the right request before deciding. |
| Sender labels show derived technical IDs. | Names come from the authenticated workspace roster. | People and ownership are recognizable. |
| The primary action says “Tell your AI”; content goes directly from free text to send. | New request → choose recipient → prepare → edit subject, recipient, request, background, type and priority → send. | Users review the actual message and destination before committing. |
| Sent and Done are temporary overlays over Inbox. | Sent and Completed have their own searchable queues and detail states. | Users can follow the outcome and return to previous decisions. |
| Context is cut off by the giant card and controls. | Detail views scroll naturally, preserve background and original text, and keep response controls reachable. | A decision needs enough context to be understood. |
| Native onboarding requires intro steps before usable content. | A short welcome offers a clearly labeled local demo immediately, with GitHub connection as a separate path. | The product can be understood through a real interaction. |
| Guest content is sparse and its persistence/notification behavior is unclear. | Isolated sample workspaces contain pending, sent and completed examples with create, approve, reply, undo, reset and exit actions. | Reviewers can safely try the full core workflow without pretending it is a live account. |
| Settings dominate the personal tab. | Workspace puts people and connections before preferences and account management. | Users can understand who is present and which data sources are connected. |
| Visual style mixes giant display text, pill controls and decorative effects. | Shared paper/ink palette, restrained violet, readable typography, real icon libraries and system-aware dark appearance. | The interface supports repeated daily use and scanning. |

## Visual evidence

Fresh web baseline and after captures use the same 390 × 844 viewport and the same disposable local workspace (Misaki Arai, Yuki Tanaka, Alex Chen and Hana Sato). The displayed relative time advances between captures. The dataset is a fixture stored through the real local Worker; it is not production customer data.

| Surface | Before | After |
|---|---|---|
| Mobile web Inbox | [Original carousel](before/02-web-authenticated-inbox.png) | [Searchable queue](after/web-fixture-inbox-mobile.png) |
| Mobile web composer | [Original direct-send sheet](before/03-web-composer.png) | See the final composer captures in `after/`. |

The intermediate `checkpoint/` captures are design review records, not final release evidence. The native checkpoint exposed a clipped action footer; this prompted replacement of the custom bottom inset with native tab ownership. A blank initial native launch capture was rejected and removed. No pre-redesign native visual comparison is claimed from that rejected image.

## Verification scope

Root browser review used the Codex in-app browser against local Vite and local Worker instances. It confirmed member-name search, full context, explicit response-completes-request copy, saved response text in Completed, and undo returning the request to Inbox. The fixture response was undone after this check. Root also selected a demo recipient, edited subject and recipient in the review step, created the sample request, and verified the edited values in Sent.

Automated browser regression checks exercise the actual application and local Worker rather than a static visual mock. Native verification uses the iPhone 17 Pro iOS 26.4 simulator, with additional model/service tests. Final test results and visual review notes are appended below after verification completes.

## Remaining release boundaries

This is a local implementation and review candidate. Screenshots and passing tests do not establish product acceptance, physical-device accessibility conformance, TestFlight signing, App Store readiness, paid AI-provider behavior, or live OAuth/push/email delivery. No production deployment, merge, TestFlight upload, external notification, or Figma publication is part of this change.

The record endpoint reflects stored current outcomes, not an immutable activity ledger. Undo restores request state; external source writes are not reversed. Tool invitations create invite tokens; the UI must not claim an invitation email was sent.
