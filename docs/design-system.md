# Honmaru AI product design

The September 2026 redesign organizes the product around requests: find what needs your attention, understand the context, respond, and follow the outcome. This document describes the implemented direction for the native app and React web app. It supersedes the earlier card carousel, forced swipe onboarding, and all-pill prototype rules.

## Information architecture

| Destination | Purpose |
|---|---|
| Inbox | Requests addressed to you that still need attention. Search people or content; filter by request type or priority; sort deliberately. |
| Sent | Requests you created, with recipient and current status. System-generated response notifications do not count as requests you created. |
| Completed | Decisions and completed requests, including who responded and the stored outcome when available. This is the current record, not an immutable audit log. |
| Workspace | People, tool connections, preferences, and account controls. |

Desktop web uses a persistent navigation rail, a searchable request list, and a detail pane. Narrow screens and iPhone use a list followed by a detail screen with an explicit Back action. A single New request entry remains available across destinations. Detail actions must stay visible above the keyboard, home indicator, and navigation.

## Request creation and outcomes

1. Choose a real workspace member and describe the request. Text is the default input; voice or camera is an explicit choice.
2. Prepare a draft manually or with AI when available. Show whether AI was used. Preserve the original instruction as context.
3. Review and edit the recipient, subject, request, background, type, and priority before sending.
4. Confirm delivery from the authenticated workspace response. An optimistic update or local cache alone must not claim confirmed delivery.

Approval, reply, completion, and revision actions explain their effects. Replies that finish a request must say so. Undo restores the request state; it must not imply that an external GitHub issue or notification has also been undone.

The sample workspace is explicitly marked as local demo data. Its people and requests are illustrative. It performs no external AI calls, notifications, or tool writes. Reset and exit are available. Live sessions use the authenticated member roster and workspace data.

## Visual roles

| Role | Light | Dark |
|---|---|---|
| Canvas | `#F7F8FA` | `#0F1115` |
| Content surface | `#FFFFFF` | `#191C22` |
| Raised surface | `#F0F1F5` | `#222631` |
| Primary text | `#20242C` | `#F4F5F7` |
| Secondary text | `#626873` | `#B5BDC9` |
| Hairline border | `#E5E7ED` | `#2D323D` |
| Brand / AI / selection | `#6650CB` | `#B4A1FF` |
| Primary action | dark ink, white text | near-white, dark ink text |
| Positive action status | green | light green |
| Destructive or blocked status | red | light red |

Color never carries status alone. Pair it with a readable label and icon. Primary actions use ink rather than violet. Cards have a restrained border; shadows are reserved for overlays and floating controls. Gradients and animated rings are not part of the work surface.

Native `Theme.Colors.background` is the content surface; `surface` is the surrounding canvas. The names are retained for existing view compatibility. Web semantic variables live in `web-react/src/index.css`; native roles live in `TikTokForWork/Design/Theme.swift`.

## Components and readability

- Use SF Symbols on iPhone and Lucide icons on web; retain the product's real logo asset.
- Use the system font stack. Native body text follows Dynamic Type; web body text is 14–16 px. Request subjects are prominent without hero-sized marketing typography.
- Use a 4 px spacing rhythm, 12–14 px control corners, and restrained 12–20 px card corners. Pills are for compact status chips, not every control.
- A request row shows person, time, subject, a short summary, and the few metadata fields needed to triage. The detail screen carries full context and original text.
- Inputs have persistent labels. Buttons name their action. Loading, empty, offline, error, and success states offer the next useful step.
- Respect Reduce Motion, system appearance, keyboard focus, modal focus containment, and large text. Visual screenshots do not establish full accessibility conformance.

## Design reference and verification

The existing [Honmaru design file](https://www.figma.com/design/ii8w8x7gvN3wp70vlszBSa/Honmaru-AI-Mobile-App-UI-UX-Design) remains historical product context. Node `470:282` was read during this redesign to verify the existing decision-detail hierarchy. The new queue and draft flow are an intentional product redesign, not a claim of pixel matching every historical Figma frame. No Figma frames were published during this change.

Current evidence and Before / After / Why review are recorded in [the September UX review](ux-redesign/2026-09-08/README.md). Release qualification remains separate from visual acceptance and local build success.
