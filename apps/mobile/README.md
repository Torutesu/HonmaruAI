# Honmaru mobile (Expo) — PoC-B

The React Native app for iOS and Android from
`docs/architecture/discord-model-platform-plan.md` §11–12. It shares its
logic with the web through `packages/core` (API client, channel sync,
@mention rules) and `packages/protocol` (the API's shapes); only the views are
its own.

What it does today: sign in with an emailed code or with Apple (iOS), the
workspace's channels with unread counts, and a channel's messages (FlashList
v2) with sending, older pages, and catching up when the app comes back to the
front — all over `/v2`, the per-workspace Durable Object (PoC-A). Push and
links into the app: see below.

`/v2` is off in production unless `WORKSPACE_V2` names the workspace. Point
`expo.extra.apiBase` in `app.json` at staging, or enable a test workspace.

## Run it

From the repository root (npm workspaces: `apps/*`, `packages/*`):

```sh
npm install
cd apps/mobile
npx expo start            # Expo Go is enough for this PoC
npx tsc --noEmit          # typecheck
CI=1 npx expo export --platform ios --platform android   # what CI bundles
```

The iOS PoC bundle id is `com.honmaru.ai.poc`, so it installs beside the App Store
app. Android uses `com.honmaru.ai`, matching the registered Play Console app.
This package identity does not imply production readiness: the client still
requires a workspace enabled for `/v2` and device testing before public release.

## Android internal release

The EAS project is `@selectdev/honmaru` (configured in `app.json`). From
`apps/mobile`, run `npx eas-cli@latest build --platform android --profile internal`
for a signed AAB. The
`preview` profile produces a directly installable APK. EAS manages version codes
remotely; the internal build increments them. Upload the AAB to Google Play
**Internal testing** first. Confirm the upload signing certificate against Play
Console before generating or replacing credentials. Firebase configuration must
use the Android package `com.honmaru.ai`.

The root npm overrides keep React and the animation native modules on the SDK 57
versions: broad optional peer dependencies must not install a second native copy.
Run `npx expo-doctor` after changing dependencies.

A successful JavaScript export is not an AAB or evidence of a Play upload.
Before public release, verify login, channel access, account deletion, privacy
disclosures, notifications, and the intended billing behavior on an Android device.

Links and Sign in with Apple need native capabilities, so they work in a
development build (`npx expo run:ios|android` or `eas build --profile
development`), not in Expo Go.

## Links

A link is a real path on the web app, built and read by
`packages/core/src/links.ts` (the web uses the same rules):

| Link | Opens |
| --- | --- |
| `https://app.honmaruai.com/c/<channel>?org=<orgId>` | That channel (`src/app/c/[channel].tsx`), after switching to `<orgId>` when it is one of your workspaces; a workspace you are not in says so |
| `https://app.honmaruai.com/join/<code>` | The invitation (`src/app/join/[code].tsx`): redeemed when signed in, otherwise carried into sign-in |

`app.json` claims them — `ios.associatedDomains: applinks:app.honmaruai.com` and
an Android `intentFilters` entry with `autoVerify` for `/c/` and `/join/`.
`src/app/+native-intent.tsx` normalizes whatever the system hands over (an
`https://` link or `honmaru://c/…`) to the router's path.

The other half of the association is on the web domain:
`/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json`,
made by the Worker (`worker/src/wellKnown.js`) from `APPLE_TEAM_ID` and
`ANDROID_CERT_SHA256`, served on app.honmaruai.com by a Pages Function
(`web-react/functions/.well-known/[file].ts`). Until those variables are set the
files are 404 and links open the web instead (docs/setup-secrets.md §4.7).

Try one on a device or simulator:

```sh
xcrun simctl openurl booted "https://app.honmaruai.com/c/b%3Ageneral"
adb shell am start -a android.intent.action.VIEW -c android.intent.category.BROWSABLE \
  -d "https://app.honmaruai.com/c/b%3Ageneral" com.honmaru.ai
```

## Sign in with Apple

iOS only (`expo-apple-authentication`, `ios.usesAppleSignIn` and its config
plugin in `app.json`). The app hands Apple the SHA-256 of a random nonce and
sends the Worker the identity token with the nonce itself (`src/lib/apple.ts`);
`POST /auth/apple` checks the token against Apple's keys and signs the person
in — the account already linked to that Apple ID, the account with the same
proved address, or a new one (`worker/src/apple.js`). The App ID needs the
**Sign in with Apple** capability in the Apple Developer account (EAS Build adds
it from `usesAppleSignIn`).

The app also sends Apple's `authorizationCode` from the same sign-in. After
the person is in, the Worker trades it at `appleid.apple.com/auth/token` for a
refresh token and keeps it sealed on `apple_identities`; deleting the account
(`DELETE /account`) revokes it at `appleid.apple.com/auth/revoke` first, which
is what App Review guideline 5.1.1(v) asks of an app with Sign in with Apple.
Both calls need the Worker's Sign in with Apple key — `APPLE_SIGNIN_KEY` (the
`.p8`), `APPLE_SIGNIN_KEY_ID` and `APPLE_TEAM_ID`, see
`docs/setup-secrets.md` §4.7. Without them, or when Apple refuses, sign-in and
deletion still work; there is just nothing revoked. A sign-in made before this
kept no token, so its account has nothing to revoke until the person signs in
with Apple again; they can always remove the app themselves in their Apple
Account's Sign in with Apple settings.

## Push

`src/lib/push.ts`. On sign-in (and every launch after) the app asks for
permission, takes the phone's **native** token from
`getDevicePushTokenAsync` — APNs on an iPhone, FCM on Android, not the Expo
push service — and registers it with `POST /devices` and its `platform`.
Signing out deletes it first. The Worker sends to Apple and Google itself
(`worker/src/apns.js`, `worker/src/fcm.js`). Tapping a message notification
opens `/c/[channel]` in its workspace (`pushTarget` in `packages/core` reads
the payload on either platform). An iPhone groups a conversation's
notifications by `thread-id` `orgId|channel`; on Android the same key is the
tag, so the newest message in a conversation replaces the last.

What it needs, beyond a development build (Expo Go on Android has no remote
push, and a simulator has no token):

- **Android**: a Firebase project with this package name. Its
  `google-services.json` goes in the EAS file variable `GOOGLE_SERVICES_JSON`
  or at `apps/mobile/google-services.json` (git-ignored; `app.config.js` picks
  either up). The Worker needs the project's service account in the
  `FCM_SERVICE_ACCOUNT` secret (`docs/setup-secrets.md` §2b). Without the file
  the app builds and simply registers nothing.
- **iPhone**: the app registers its bundle id (`com.honmaru.ai.poc`) and the
  APNs environment its build was signed for (a development build's token is a
  sandbox token), and the Worker sends each phone under its own app's topic
  and gateway (`worker/src/apns.js` `targetFor`; allowed apps in
  `APNS_APP_IDS`, default both bundle ids). The App Store app, which sends no
  bundle id, keeps `APNS_TOPIC` and `APNS_ENVIRONMENT`. The APNs key must be a
  team key (it is, for token-based auth) — no per-app certificate.

Not yet: clearing a notification when it is read elsewhere (the Worker's
silent push goes to iPhones only, and the app does not handle it yet), and
the Notification Service Extension (sender avatars, payload decryption).

## Not in this PoC yet

The Notification Service Extension and clearing on read (Push, above), Google
sign-in on Android, RevenueCat, Jam, and the on-device measurements PoC-B is
judged by (cold start, 60 fps scroll on a low-end Android).
