# Honmaru AI — Figma alignment and release candidate review

The user corrected the design direction on 2026-09-08: use the **HonmaruAI Figma**, because the independent workbench had changed too much. This revision restores the Final Screen composition in both React Web and iPhone. The discarded workbench implementation and its after screenshots were removed.

This is a review candidate. It has not been merged to main, deployed to production, signed for distribution or uploaded to TestFlight.

## Source and traceability

[Honmaru AI Mobile App UI/UX Design](https://www.figma.com/design/ii8w8x7gvN3wp70vlszBSa/Honmaru-AI-Mobile-App-UI-UX-Design), Final Screen page `49:104`.

| Reference | Node | Captured evidence |
|---|---|---|
| Home / Decision | `470:282` | [Original 780 × 1688 raster returned by Figma MCP](reference/decision-frame.png), [Figma canvas with Classic alongside](reference/decision-470-282.png) |
| Profile | `470:288` | [Actual Figma canvas](reference/profile-470-288.png) |
| Welcome | `466:267` | [Actual Figma canvas](reference/welcome-466-267.png) |
| Focus / challenges | `466:279`, `466:280` | [Actual Figma canvas](reference/onboarding-466-279.png) |

The MCP design context for Home contained one raster image, not editable components or a token tree. After Figma's Starter read quota was reached, the public Figma UI supplied the remaining reference captures. No Figma write was made. Node `707:144` is a cropped bottom navigation asset, not a full Home reference.

The product mark was extracted without redrawing from the actual Welcome canvas at 200% (`welcome-200pct.png`, x656/y358, 128 × 128). `honmaru-mark.png` is a 2× raster for the 64pt reference slot. It is not a vector export. Native SF Symbols and the web icon library provide functional UI icons; absent requester photographs use neutral avatars.

## Before / After / Why

| Rejected or broken behavior | Current revision | Reason |
|---|---|---|
| Persistent three-pane workbench and four native tabs diverged from Figma. | Cards / Classic, round decision controls, bottom composer, Home / Plus / You. | Return to the user's design source. |
| Independent marketing welcome and old stacked-card mark. | Centered Figma welcome with original mark and two pill entry buttons. | Preserve the intended first impression. |
| Demo You screen differed from actual Profile. | Same Profile composition for authenticated and local sample sessions. | The preview represents the product's real interface. |
| Classic lacked the Figma workspace header and search. | Violet header, search, filters, readable request rows. | Preserve the visual hierarchy while using real request data. |
| Default native decision buttons were clipped by the bottom composer. | Actions sit outside the card's scrolling area. | Decisions stay reachable with long content and large text. |
| New UI bypassed existing Notion database selection. | Active Tools flow requires and saves a database before sync. | A visual revision must preserve working connection prerequisites. |
| Optimistic mutations could appear confirmed before the expected server update. | Expected-content confirmation, pending states, retained drafts and retry guidance. | Avoid false success and lost edits. |
| Account changes could race delayed email/billing/delete callbacks. | Session-generation guards, serialized billing identity and SDK-identity readiness. | Prevent one account's result affecting another account. |

## Deliberate adaptations

- Web omits the iOS clock and home indicator. Native uses the real device safe areas (iPhone 17 Pro is 402 × 874 pt); the Figma reference is 390 × 844 pt.
- Classic groups actual waiting, sent and completed requests. Fake channels, source counts, online portraits and unread counts were not added.
- Recommendation panels render received recommendation data. The Figma budget example is explicitly local sample data; it performs no real approval, AI call or notification.
- Profile displays the real model/connection/billing state, rather than the source's illustrative Slack-active or two-day-trial labels. Demo and unavailable controls are labeled accordingly.
- Web setup uses the reference's centered question/pill structure but saves supported role and language fields. Unsupported focus/challenge answers are not collected and discarded. Native exposes editable work context through Profile.
- Dark appearance and Dynamic Type are functional adaptations. Passing screenshots do not establish full accessibility conformance or pixel identity across platforms.

## Validation

| Check | Result | Evidence |
|---|---|---|
| Worker | 62 files, 353 tests passed | [Backend summary](backend-tests.json) |
| Reference Node relay | 11 tests passed | [Backend summary](backend-tests.json) |
| Web unit tests | 23 passed | Web `npm run test:run`; production build also passed |
| Web browser workflow | 12 groups passed; zero runtime errors or unexpected external requests | [Checklist](browser-regression/checks.json) |
| Native model/service tests | 58 passed | [Native summary](native-tests.json) |
| Native Release | Build, clean install and 12-second launch survival passed | [Native summary](native-tests.json) |
| Visual responsiveness | 390 × 844, 320 × 768, desktop 1440 × 1000; dark and Japanese checked | [Visual checklist](after/web-visual-checks.json) |

The native 58-test run includes email activation, cache/outbox isolation, exact pending-delivery matching, cancelled/deferred session callbacks, serial billing identity, failed-identity purchase gating, and live JA→EN localization. Subsequent UI-only large-text and Classic-header corrections, plus seven missing Japanese strings, are validated by the Release builds and direct simulator review.

Web large-text evidence is an explicit 30% text-size simulation, not OS Dynamic Type. Native checks use actual simulator accessibility-extra-large text; approval and Undo remain operable above the composer.

Historical results under `docs/release-evidence` and `web-react/qa/2026-09-08` apply to their stated older commits and are not evidence for this revision.

Root interaction review uses the Codex in-app browser and the iPhone 17 Pro simulator. The workflow checks include edited recipient/subject before local sample send, Classic search by member, approval and undo, Profile language changes, and paths into history and settings. The automated browser harness also exercises the real local Worker with disposable test accounts, not production customer data.

## Final visual comparison

The root reviewer inspected the source and final screenshots together. The original Home card hierarchy, white/ink/violet roles, rounded borders, separate circular decisions, bottom composer and three-item navigation are restored. Profile and Welcome were checked against their actual Figma canvas captures. The native clipped action footer, mixed-language copy, web demo-only Profile, dark Profile mismatch and offscreen-card focus exposure found during review were corrected.

| Surface | Current evidence |
|---|---|
| Figma vs Web Home, same 390 × 844 layout | [Side-by-side](after/web-decision-comparison.png) |
| iPhone English Home | [Simulator capture](after/ios-home-en.png) |
| iPhone Japanese Home | [Simulator capture](after/ios-home-ja.png) |
| Web Profile | [Light](after/web-profile-demo-mobile.png), [Dark Japanese](after/web-profile-ja-dark.png) |
| Web Welcome | [Mobile](after/web-welcome-mobile.png), [Desktop](after/web-welcome-desktop.png) |
| iPhone Classic | [Final Release](after/ios-release-classic-ja.png) |
| Web Classic | [Mobile](after/web-classic-mobile.png), [Desktop](after/web-classic-desktop.png) |
| Editable preview | [Mobile](after/web-compose-preview-mobile.png) |

These screenshots show local sample content. No source counts, portraits or external actions were fabricated to fill the design. Relative timestamps and real platform safe areas differ from the static reference.

Final native Release review confirmed the enlarged header uses separate rows without splitting words; actions remain visible. [Japanese AX3 dark Release capture](after/ios-release-ja-ax3-dark.png). Simulator settings were restored to standard large text and light appearance after review.

## Release boundaries

No production D1 migration/deployment, paid AI request, real email/OTP delivery, OAuth callback, APNs/Web Push delivery, StoreKit purchase, physical-device qualification, signing or TestFlight upload is proven by these local checks. The reference Node relay and the Cloudflare Worker are separate implementations with separate test evidence. Undo restores stored request state and does not reverse external tool writes.
