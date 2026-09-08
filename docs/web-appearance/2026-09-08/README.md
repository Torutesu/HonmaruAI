# Public web PC / dark appearance correction

The public Pages deployment inspected on 2026-09-08 was `b9860d06-4350-42dc-9ce9-f274eb4edf6a`, source `7dad95c`. It still served the older welcome/desktop rail implementation, not this branch's Figma alignment. Its dark welcome rendered pale text over a light background. [Observed public screen](public-before-dark.png).

This correction ships the Figma-aligned centered layout and adds shared dark surfaces, readable labels, matching input/hover states and complete detail/history color roles. Desktop authentication has its own bounded centered form. At short laptop heights, the standard card now includes the recommendation without scrolling; long user content still scrolls independently of the decision controls. The public backend's Google Calendar / Drive labels and descriptions from upstream are retained with the existing icon library.

| Screen | Evidence |
| --- | --- |
| PC decision, light / dark | [Light](light-1280x720-feed.png), [Dark](dark-1280x720-feed.png) |
| Dark welcome / sign-in | [Welcome](dark-1280x720-welcome.png), [Sign-in](dark-1280x720-sign-in.png) |
| Dark Profile / Classic | [Profile](dark-1440x900-profile.png), [Classic](dark-1440x900-classic.png) |
| Dark mobile | [390×844](dark-390x844-feed.png) |

Validation: 23 unit tests and TypeScript/production build pass. The cold production frontend with a disposable local Worker passed all12 workflow groups. The actual release bundle, configured for `https://tiktokforwork.torubj0904.workers.dev`, passed84 layout checkpoints across6 viewports,7 screens and light/dark modes. The sample tests block all backend/provider requests. Key dark text is measured at 4.5:1 or greater; no horizontal overflow, control overlap, standard desktop recommendation clipping or browser errors was found. [Measurements](checks.json).

The screen capture covers an editable test form; no production credentials, email or authentication request was submitted. Native code and App Store screenshots are outside this web correction. Local workflow testing does not establish live provider/account behavior. Production deployment identity and asset verification, when completed, are recorded separately in `deployment.json`.
