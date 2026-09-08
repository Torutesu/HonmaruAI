# Honmaru AI — Figma implementation contract

The source of truth is **Final Screen** in [Honmaru AI Mobile App UI/UX Design](https://www.figma.com/design/ii8w8x7gvN3wp70vlszBSa/Honmaru-AI-Mobile-App-UI-UX-Design). The user explicitly rejected the independent workbench redesign on 2026-09-08. Do not reintroduce its navigation rail, three-pane layout, four native tabs, or marketing welcome page.

## Reference screens

| Screen | Figma node | Required composition |
|---|---|---|
| Home / Decision | `470:282` | Cards / Classic switch, avatar, bordered white decision card, round decline / approve controls outside the card, Ask anything composer, Home / Plus / You navigation. |
| Profile | `470:288` | Centered title, identity and assistant card, AI / Language / Notifications / History group, plan and sign-out group. |
| Welcome | `466:267` | Original 64px mark, centered two-line welcome, short subtitle, black and outlined pill entry buttons. |
| Focus onboarding | `466:279` | Centered question and selectable pills. Web currently saves the supported role field. |
| Challenges onboarding | `466:280` | Question and pill layout reference. No unsupported challenge answers are collected; the next Web step saves language. |

These are image-backed designs. The original Decision image was returned by Figma MCP; subsequent screenshots were captured from the Figma UI after its read quota was reached. No editable typography or component-token tree was available. The original mark is a 128px raster asset captured at 200% from the Welcome reference, not a reconstructed vector. Source captures and validation are in [the Figma alignment review](figma-alignment/2026-09-08/README.md).

## Visual roles

| Role | Light | Dark adaptation |
|---|---|---|
| Canvas | `#FBFBFC` | `#0F1115` |
| Card | `#FFFFFF` | `#191C22` |
| Neutral control | `#F2F2F2` | `#222631` |
| Primary text | `#202020` | `#F4F5F7` |
| Secondary text | `#666666` | `#B5BDC9` |
| Border | `#E8E8E8` | `#2D323D` |
| Recommendation panel | `#F5F1FF` | Semantic violet surface |
| Violet accent | `#6647F0` | `#B4A1FF` |
| Primary action | `#111111` with white | Near-white with dark text |

Keep the mobile reference hierarchy on desktop with a bounded readable width. Do not add a persistent sidebar. Web uses a shared centered frame: up to 430px on phones, 520px from 700px viewport width, and 720px from 900px. Desktop content has 24px horizontal gutters, 30px decision headings and 16px body text; the summary uses the available card width. Header, card, composer, Classic and Profile share the same center. Reserve the 88px navigation height plus 24px desktop / 12px mobile clearance. At short heights, the card body scrolls while decisions and composer remain outside it. Desktop dialogs are centered in both axes; the Welcome introduction and entry buttons form one centered stack. These are web desktop adaptations, not an additional Figma desktop frame. Use SF Symbols on native and the existing icon library on web. Use actual source imagery and avatars when available, a neutral person icon otherwise. Native `Theme.Colors.background` remains the card surface and `surface` the canvas for compatibility.

## Functional requirements

- Cards and Classic are real views of the same authenticated requests. History is accessible from Profile. Sample content must be explicitly identified as local demo data.
- Source counts, channels, portraits, original links, recommendation reasons and AI availability must come from actual data. Do not fabricate them to fill the reference image. A sample recommendation is confined to the labeled sample workspace.
- The bottom composer prepares a request. Let the user select a real workspace member and edit recipient, subject, request and background before sending. Preserve the draft on validation, connection or server errors.
- A send or response is confirmed by an authenticated server echo of the expected mutation. A pending local cache entry is not proof of delivery. Block sending while disconnected and fence callbacks when identity changes.
- Approval, decline, reply and acknowledgement match the actual request type. Show the outcome in History; undo does not imply external writes are reversed.
- Decision buttons stay reachable outside the scrollable card body at all supported text sizes. Long text scrolls without covering actions. Keyboard focus, sheet dismissal, dark appearance and reduced motion remain usable.
- Email OTP, GitHub sign-in, workspace membership, tool connections, language, notifications and billing routes remain available. Claims about delivery, model availability or a paid plan use actual service state.

The Figma references define the visual structure. Platform safe areas, browser chrome, long content and accessible text sizes require measured adaptations; they are recorded as such rather than claimed as pixel-identical. Local build/tests and Figma comparison do not prove TestFlight signing, physical-device behavior, real paid-provider calls or production deployment.
