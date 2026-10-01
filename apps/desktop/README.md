# Honmaru AI — desktop

The web app (`web-react/`, deployed at https://app.honmaruai.com) in its own
window on Windows, macOS and Linux. It adds what a browser tab can't do:

| | |
|---|---|
| **Stays running** | Closing the window hides it to the tray (Windows, Linux) or the dock (macOS), as Discord does, so notifications keep arriving. Quit from the tray or the menu (Ctrl+Q). Logging off, shutting down or an update still closes it. |
| **Unread count** | The count in the page title (`(3) Honmaru AI`) appears as a red dot on the Windows taskbar, as the dock or launcher badge on macOS and Linux, and in the tray tooltip. When it goes up while the window is in the background, the taskbar flashes or the dock bounces once. |
| **Notifications** | Native, through the web app's own notifications. Windows needs the app identity `com.honmaru.ai`, which is set. |
| **`honmaru://` links** | `honmaru://c/<channel>?org=<orgId>` opens a conversation and `honmaru://join/<code>` an invitation. These are the same paths as the web links (`packages/core/src/links.ts`). A second launch hands its link to the running app, which moves to it inside the page (by its hash route) without reloading, so a half-written message stays. |
| **Remembers its place** | Size, position and maximized state. If that screen is gone, the window opens on the main one. |
| **Recovers** | A page that crashes is reloaded. One that crashes three times in a minute is not reloaded again: the app says so and offers to try again or quit. |
| **Always current** | It loads the deployed web app, so a web deploy updates it. Only the shell itself needs an installer. |

## Run it

```bash
cd apps/desktop
npm install
npm start                 # against https://app.honmaruai.com
npm run dev               # against the web dev server on http://localhost:3000
npm test                  # the rules: links, navigation, the CSP, the count, window placement, crashes
npm run dist:dir          # an unpacked, unsigned app in dist/, to try locally
npm run dist              # signed installers in dist/ (refuses without signing)
npm run release           # the same, uploaded to a draft GitHub release
```

While developing (`npm start`, `npm run dev`), `HONMARU_APP_URL` or
`--app-url=<url>` points it at another web build, and `HONMARU_API_ORIGINS`
(comma-separated) adds that build's API. Each must be https; plain http is
accepted only for `localhost`. An installed app ignores all three: it always
loads https://app.honmaruai.com and its API, so nothing on the command line or
in the environment can point a signed app at another site.

## Security

Following the baseline in `docs/architecture/discord-model-platform-plan.md` §11.4:

- `contextIsolation`, `sandbox` and no `nodeIntegration`. The preload exposes
  only `window.honmaruDesktop = { isDesktop, platform, show() }`.
- A strict Content-Security-Policy on the app's pages, added by the shell to
  every response from the app's origin (`src/csp.js`): scripts only from the
  app itself plus the one inline theme script in `web-react/index.html`,
  allowed by its sha256 hash (change that script and `test/csp.test.js`
  fails until the hash in `src/csp.js` is updated); connections only to the
  app, the API and its wss relay; images also from any https site (avatars,
  link previews); frames only YouTube's player; no plugins, and no framing
  by other sites. It is sent beside any policy the server sends, so it can
  only narrow what the page may do. The dev policy adds what Vite's hot
  reload needs, and only when pointed at a local http server.
- Permissions (notifications, microphone and camera for Jam, full screen,
  clipboard write) are granted only to the app's own origin.
- The window stays on the app, its API and GitHub. Every other link opens in
  the default browser, and only `http(s)` and `mailto` links are handed to
  the system. `<webview>` is refused.
- Company sign-in (SSO). When the API redirects the window to a company's
  identity provider, exactly that one origin (https only) may load, for up to
  3 minutes; the allowance ends as soon as the window is back on the API or
  the app. A link on the identity provider's page to any other site opens in
  the browser. While the window is off the app, its title names the site
  (`Honmaru AI — signing in at login.company.example`), since there is no
  address bar.

  Why not the system browser? Signing in there would leave the session in
  the browser, not in the app: the Worker ends a web sign-in by sending the
  browser to `app.honmaruai.com/#/sso/done?code=…`, and only knows how to
  hand the code to the iOS app's own scheme. Doing it properly needs the
  Worker to accept a `client=desktop` sign-in that returns to
  `honmaru://sso?code=…`, and the web app to start one when it runs in the
  desktop app — both outside this shell. Until then the in-window sign-in is
  kept, as narrow as it can be. An identity provider that hands off to a
  second origin of its own (federation to another provider) opens that step
  in the browser and will not complete in the app.
- A page that opens a blank window to point it at a tool's sign-in (Tools,
  Smithery apps) gets a hidden window whose first navigation goes to the
  browser. One that is still blank after 30 seconds is closed.

The rules live in pure modules (`src/links.js`, `src/config.js`,
`src/csp.js`, `src/badge.js`, `src/windowState.js`, `src/crashes.js`), each
with its tests in `test/`. `src/main.js` only wires them to Electron.

## Releasing

`npm run dist` and `npm run release` first run `scripts/signing.mjs`, which
refuses to build installers that would not be signed, and says what is
missing. They build for the platform they run on:

| Platform | Needs |
|---|---|
| macOS | A Developer ID Application certificate (`CSC_LINK` + `CSC_KEY_PASSWORD`, or `CSC_NAME` from the keychain) and notarization (`APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER`, or `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`). |
| Windows | A code-signing certificate (`WIN_CSC_LINK` or `CSC_LINK`, + `CSC_KEY_PASSWORD`). Azure Trusted Signing needs `win.azureSignOptions` in `electron-builder.yml` and a matching check in `scripts/signing.mjs` first. |
| Linux | Nothing: an AppImage is not code-signed. |

`npm run release` also needs `GH_TOKEN` (a token that can create releases on
Torutesu/HonmaruAI). It uploads the installers and the update feed
(`latest*.yml`) to a draft release; publishing the draft is what offers the
update.

**From CI.** Bump `version` in `package.json`, then run *Actions → Desktop
release → Run workflow* (`.github/workflows/desktop-release.yml`). It checks
the selected platform signing secrets before building. The default `mac`
option needs `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_API_KEY_P8`,
`APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`, and produces a universal Mac app
for Apple silicon and Intel. The `all` option also requires `WIN_CSC_LINK`
and `WIN_CSC_KEY_PASSWORD` and builds Windows and Linux. Both create the
`v<version>` draft once; verify signing, notarization and launch before publishing.

**Microphone and camera (Jam) on a Mac.** The hardened runtime needs the app
to claim them: `resources/entitlements.mac.plist`, with the usage descriptions
in `electron-builder.yml` (`mac.extendInfo`). The first signed build should be
checked once by joining a Jam call: macOS asks, and the call has sound and
video.

**Updates.** An app built by `dist` or `release` (and only those: they mark
its `package.json` with `honmaruUpdates`) checks the repository's GitHub
releases with `electron-updater` at start and every six hours, downloads a
newer version in the background — verified against the release's sha512 and,
on Windows and macOS, against the running app's signature — and installs it
on the next quit, or right away if the person picks "Restart now". `npm start`
and `dist:dir` builds never check. electron-updater takes the newest published
release of the repository, so desktop releases have to be the newest ones
there, or move to a repository of their own.

## Not yet

- Azure Trusted Signing for Windows (`win.azureSignOptions`) instead of a
  .pfx certificate.
