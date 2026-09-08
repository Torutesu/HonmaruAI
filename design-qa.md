# Web Figma implementation QA — 2026-09-08

**Scope:** the web decision screen and its operational states. This is local implementation evidence, not production deployment, physical-device qualification, or user design acceptance. The earlier three-pane redesign was rejected and has been removed.

**Source visual truth:** `docs/figma-alignment/2026-09-08/reference/decision-frame.png`, the exact MCP export of Figma Final Screen 470:282, 780×1688 physical pixels / 390×844 logical pixels. Supporting references: `decision-470-282.png` (Classic and composer), `profile-470-288.png`, `welcome-466-267.png`, `welcome-200pct.png`, and `onboarding-466-279.png` in the same reference directory.

**Implementation:** `http://127.0.0.1:4319/?demo=figma`; the running production component uses a clearly labeled, client-isolated sample workspace. `web-react/scripts/capture-figma-evidence.mjs` reproduces screenshots without credentials, backend data, or provider requests. Real Worker integration is separately exercised by `web-react/scripts/browser-smoke.mjs` and the cold CI harness.

## Normalized comparison

Both decision images are 780×1688 pixels captured/rendered at 390×844 CSS pixels and density 2. The side-by-side comparison is `docs/figma-alignment/2026-09-08/after/web-decision-comparison.png` (1640×1768). The implementation image is `web-decision-figma-fixture-mobile.png` in the same directory.

This pair deliberately does **not** assert identical account/content state. The reference contains iOS clock/battery/home-indicator chrome, a Sarah Chen portrait, 33 combined sources, and a recommendation. Web does not draw device chrome. The sample names the actual local fixture member Maya Chen, labels the recommendation as sample content, and shows a sample source. Live requests render only real supplied source links and recommendations; missing avatar data uses the standard Lucide user icon. No source count, connected provider, portrait, or AI outcome is fabricated. These are required product-data adaptations, not new visual direction.

The full pair was visually inspected at readable resolution; title, source, requester, recommendation, and action regions are legible in this comparison, so a separate region crop was unnecessary.

## Findings and fixes

The initial mobile comparison passed, but the subsequent PC review found a narrow summary, inconsistent screen widths, a short-height composer/navigation overlap and a Profile-to-compose layering bug. The desktop follow-up below supersedes the earlier desktop layout assessment. This is not a claim of a pixel-identical clone.

- **Typography:** shared CSS from the older detail component originally reduced the decision title to 16px and overrode its summary color. Scoped feed selectors now preserve the 24px display title, restrained 12px summary, small requester metadata, and mono section/priority labels. Inter, Plus Jakarta Sans, and Sometype Mono are self-hosted; Japanese uses the system fallback. Optical/font-wrap differences from the raster remain a minor refinement, with the same heading/body hierarchy and number of major regions.
- **Spacing/layout:** restored one bounded rounded card, two separate circular decisions, lower input pill, and Home/Add/You navigation. Desktop remains a centered readable column. Classic restores the reference's purple workspace header, mode switch, and search/filter area, backed by real waiting/sent/decided groups. Profile uses the same composition for sample and authenticated accounts. Web viewport edges replace device safe-area chrome; enlarged body content scrolls inside the card while actions remain reachable.
- **Colors:** the primary light screen uses canvas `#FBFBFC`, card `#FFFFFF`, recommendation `#F5F1FF`, ink `#111111`, secondary `#666666`, border `#E8E8E8`. Dark foreground collisions and the white-Profile/dark-navigation mismatch were found and corrected with semantic dark counterparts.
- **Images/icons:** the welcome mark is the original Figma raster supplied by the root review, displayed at 64px. Generic controls use Lucide. Account avatars and source links depend on real data; standard fallback icons are intentionally used when the source portrait/data is unavailable. No hand-drawn replacement brand assets were introduced.
- **Copy/content:** actual request title/summary/original context and names are rendered. Routing bookkeeping is suppressed only where it exactly matches generated identity segments. Explicit local sample labels, sample-only recommendations, no-notification wording, supported role/language onboarding, and actual configured/fallback AI status avoid unsupported product claims.

## Comparison history

1. **Blocked:** the independent workbench direction did not follow Figma. Replaced its surfaces and deleted the unused workbench/composer/workspace implementations.
2. **Blocked:** title/summary selector collision; dark title low contrast. Scoped selectors and dark foreground overrides fixed both. Final mobile light/dark captures show readable text.
3. **Blocked:** Profile navigation hidden by CSS specificity, background feed/Classic focusable after locale remount, and all five offscreen card actions exposed. Stronger Profile navigation rule, screen/mode/locale/panel-aware inert handling, and active-card-only accessibility fixed these. The browser regression keeps these assertions.
4. **Blocked:** sample Profile used a different generic page, Classic lacked the reference header/search, and Profile mixed light and dark surfaces. Unified Profile with a no-network sample mode, restored Classic's header/search, and added semantic dark Profile styles. Final light/dark/JA captures supersede earlier CUA screenshots of these defects.
5. **Passed:** final source/implementation comparison and final capture checks described below. The read-only review also found and fixed confirmation races; those are covered by unit/browser checks rather than claimed as visual evidence.

## Final evidence

All filenames below are in `docs/figma-alignment/2026-09-08/after/`:

| Surface | Evidence |
| --- | --- |
| Decision source comparison | `web-decision-comparison.png` |
| Decision mobile / desktop | `web-decision-figma-fixture-mobile.png`, `web-decision-figma-fixture-desktop.png` |
| Welcome mobile / desktop | `web-welcome-mobile.png`, `web-welcome-desktop.png` |
| Classic mobile / desktop | `web-classic-mobile.png`, `web-classic-desktop.png` |
| Shared sample Profile mobile / desktop | `web-profile-demo-mobile.png`, `web-profile-demo-desktop.png` |
| Dark decision / Profile | `web-decision-mobile-dark.png`, `web-profile-demo-mobile-dark.png` |
| Japanese decision / Profile | `web-decision-demo-ja-mobile.png`, `web-profile-demo-ja-mobile.png`, `web-profile-demo-ja-dark.png` |
| Editable preview with pinned actions | `web-compose-preview-mobile.png` |
| 30% text-size simulation | `web-decision-large-text-simulation.png`, `web-decision-large-text-scrolled.png` |
| Narrow responsive viewport | `web-decision-narrow-mobile.png` |
| Exact visual-check metadata | `web-visual-checks.json` |

The text-size simulation explicitly enlarges UI text by 30%; it is not evidence of an OS accessibility setting or physical-device Dynamic Type behavior. Scrolling reaches the end of enlarged card content; decisions/input/navigation stay usable. Mobile is 390×844, desktop 1440×1000, and the narrow check is 320×768; density is 2.

The capture script checks a single accessible decision, persistent Profile navigation, background isolation after language changes, dark title contrast, preview actions within the viewport, enlarged text reaching the card's end, no horizontal overflow, no unexpected backend/provider requests, and no browser runtime errors. The separate browser suite exercises signup/onboarding, real roster and editable preview, server-confirmed creation/approval/undo, reply/history/reload, Notion configuration before sync, Japanese profile behavior, abandoned draft isolation, and memberless workspace recovery.

## Implementation checklist

- [x] Restore Figma decision hierarchy, welcome mark/layout, Classic header/search, and Profile composition.
- [x] Keep supported data/API features and truthful sample/provider states.
- [x] Verify dark/mobile/desktop/JA/narrow and enlarged-text behavior.
- [x] Preserve draft/account scopes; validate expected persisted create and reply contents before success.
- [x] Save reproducible browser evidence without credentials or storage state.
- [ ] Root release review, user design acceptance, and deployment/device qualification remain separate work.

**Follow-up polish (P3):** exact font optical metrics and portrait/source artwork can be reconciled further when corresponding Figma assets and actual account/source data are available. This does not justify fabricated account imagery or unsupported source counts.

final result: passed for the original mobile comparison; see the desktop follow-up for the current PC review.

## Desktop follow-up — 2026-09-08

The PC layout now uses one 720px centered frame with readable desktop typography, a full-width summary, consistent Profile/Classic alignment and centered dialogs. Short-height layouts derive their content reservation from the actual navigation height. Profile closes before opening the composer. The original 390×844 mobile composition remains intact. The source screenshot and current mobile capture were visually compared; actual account/source artwork and browser/device chrome remain the documented adaptations.

See [desktop review](docs/desktop-layout/2026-09-08/README.md) for the final viewport matrix, geometry evidence, screen captures and limitations. The shared responsive rules are in `web-react/src/responsive.css`; layout checks also run against the cold production bundle in the browser CI gate.
