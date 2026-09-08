# What is left, and who does what

Written for whoever picks this up next. Everything here is outside the Swift
and the Worker — it is Apple Developer portal work, App Store Connect data
entry, and one asset that has to come out of Figma. None of it can be finished
from the repository alone, which is why it is a list rather than a commit.

**State as of this document.** Build 1.0 (32) is on TestFlight. Do not submit
it: it predates the app icon, push, and the billing fixes. The branch
`claude/ai-management-os-notifications-i2egoy` has all three.

Already done, so nobody re-does it: password sign-in for review (2.1), GitHub
removed as an iOS door (4.8), account deletion (5.1.1(v)), `PrivacyInfo.xcprivacy`,
export compliance, Japanese localisation, the demo account, domain-verified
email, the support address, the APNs secrets.

---

## 1. Push — the portal half is blocking every build

**Nothing compiles for release until this is done.** The entitlement is now
wired in `project.yml` with `aps-environment` resolved per configuration. An
App ID without the capability makes signing fail, so this is step one and not
step three.

1. <https://developer.apple.com/account/resources/identifiers/list> →
   `com.honmaru.ai` → tick **Push Notifications** → **Save**.
2. Reissue the distribution profile, because the old one was minted before the
   capability existed:

   ```bash
   cd ~/HonmaruAI && source .asc.env
   asc profiles list          # note the id of "HonmaruAI AppStore"
   asc certificates list      # note the distribution certificate id
   asc profiles delete --id "$OLD_PROFILE_ID"
   asc profiles create --name "HonmaruAI AppStore" --profile-type IOS_APP_STORE \
     --bundle com.honmaru.ai --certificate "$CERT_ID"
   ```

3. Confirm D1 has the table registration writes to:

   ```bash
   cd ~/HonmaruAI/worker
   npx -y wrangler@4 d1 execute tiktokforwork --remote \
     --command "select count(*) from device_tokens"
   ```

   `no such table` → `npx -y wrangler@4 d1 execute tiktokforwork --remote --file schema.sql`.

**Done when:** `scripts/release.sh build 1.0` archives without a signing error,
and a notification actually arrives on a TestFlight device. The second half is
the only proof that counts — `/health` reporting `push: true` means the secrets
exist, not that Apple accepts them.

---

## 2. The app icon — it must come out of Figma

The icon in the tree is **not** the designed one. The original was a grey
card-stack placeholder in `#5E6AD2`, a colour the product does not use; it has
been replaced with the tab bar's conic ring and FAB, drawn from the twelve
Figma gradient stops. That is closer, but it is a derivation, not the asset.

The design file is
[Honmaru-AI-Mobile-App-UI-UX-Design](https://www.figma.com/design/ii8w8x7gvN3wp70vlszBSa/Honmaru-AI-Mobile-App-UI-UX-Design).

1. Find the app icon frame (the `Refference` page, near the components row at
   x ≈ 18400).
2. Export it at **1024×1024 PNG**, no alpha, no rounded corners and no
   transparency — iOS applies the mask itself, and an icon that ships with one
   baked in looks wrong on the home screen.
3. Replace `TikTokForWork/Assets.xcassets/AppIcon.appiconset/AppIcon.png`.
   Nothing else changes: `Contents.json` already declares the single-size
   modern format and Xcode generates the rest.
4. Delete `scripts/make-app-icon.py` and `app-icon.svg` — they exist only to
   document the stand-in, and leaving them implies the PNG is generated.
5. Check it: `python3 -c "from PIL import Image; i=Image.open('…/AppIcon.png');
   print(i.size, i.mode)"` must print `(1024, 1024) RGB`. An `RGBA` icon is
   rejected at upload.

Match the web build too, or say why not: `web-react/public/icon.svg` is the
same mark and is the PWA's icon.

---

## 3. In-app purchase — four steps, in this order

The code side is finished and switched off. `RevenueCatConfig.apiKey` now comes
from `REVENUECAT_API_KEY` in `Config/Base.xcconfig`, so step 4 is one line.

Read `docs/app-store-review-readiness.md` §4 first — it says why the app
deliberately does not configure RevenueCat without a production key, and why
that is safe to ship.

1. **App Store Connect → Agreements, Tax, and Banking.** The *Paid
   Applications* agreement must read **Active**. Bank details and tax forms have
   a lead time measured in days, and nothing below works until it clears. Start
   here even if the rest waits.
2. **App Store Connect → Honmaru AI → Subscriptions.** One subscription group,
   two products. RevenueCat resolves packages through the dashboard rather than
   these strings, so the identifiers are yours to choose — use reverse-DNS
   (`com.honmaru.ai.pro.monthly`, `com.honmaru.ai.pro.yearly`) because a product
   id can never be changed after creation. Each needs a price, a localised
   display name and description, and a review screenshot.
3. **RevenueCat dashboard.** Attach both products to packages in the `default`
   offering, and the offering to the `honmaruai Pro` entitlement. Those two
   identifiers are matched literally by `RevenueCatConfig`; a mismatch does not
   error, it just reads as "never subscribed".
4. **The key.** Put the `appl_…` public SDK key in `REVENUECAT_API_KEY`. Also
   set the Worker's side so the server agrees about who is Pro:

   ```bash
   cd ~/HonmaruAI/worker && npx -y wrangler@4 secret put REVENUECAT_SECRET_KEY
   ```

   The secret key is the one that must never reach the app.

**Submit the subscriptions with the build**, in the same submission. A first
subscription is reviewed alongside a version; submitting the app alone means
going through review twice.

**Done when:** the Subscription screen shows plans with real prices instead of
"Upgrading isn't available in this version", and a sandbox purchase flips
`isPro` — check `/plans` reports the entitlement for that account, which proves
the app and the Worker agree on the user id.

---

## 4. The store listing — this is the actual blocker

Nothing in this section is code, and a submission is refused without all of it.
It is currently empty.

| Field | What it needs |
| --- | --- |
| **Screenshots** | 6.9" (1320×2868 or 1290×2796) is mandatory; 6.5" optional. Take them from the *next* build — the icon, sign-in screen and Subscription screen all changed. Shoot them in Japanese if Japanese is the primary locale. |
| **Description** | What the app does. No mention of other platforms, no "beta", no pricing that contradicts the products. |
| **Keywords** | 100 characters, comma-separated, **no space after the commas** — spaces count. |
| **Promotional text** | Optional, editable without a review. |
| **Support URL** | Must resolve and must show a way to reach a human. `support@honmaruai.com` receives mail via Cloudflare Email Routing. |
| **Privacy Policy URL** | Required. Must open in a browser with no sign-in and no redirect to a login. **Not written yet** — see below. |
| **App Privacy** | The questionnaire, which is separate from `PrivacyInfo.xcprivacy` and must agree with it: four data types, no tracking. A contradiction between the two is a rejection. |
| **Age rating** | The questionnaire. |
| **Sign-In Required** | `appreview@honmaruai.com` plus the password, and the notes. Exact steps: [app-review-signin-ja.md](app-review-signin-ja.md). |

`scripts/release.sh metadata 1.0` scaffolds `./metadata` and pushes the text
fields from files, which reviews better than a browser form. Screenshots and
both questionnaires have to be done in the browser.

### The privacy policy does not exist yet

It is a hard requirement and the one item here with real writing in it. It has
to cover, truthfully, what the app actually does: the account (email, name),
the decision cards and their content, what is sent to the AI provider and which
one, the connector data pulled from Gmail/Slack/Notion/Google, device tokens for
push, and account deletion. `PrivacyInfo.xcprivacy` already declares four data
types — the policy must not contradict it.

Serving it is easy: a page on the Pages deployment, or anywhere with a stable
public URL.

---

## 5. Then ship

```bash
cd ~/HonmaruAI
git checkout claude/ai-management-os-notifications-i2egoy && git pull
./scripts/release.sh build 1.0
./scripts/release.sh testflight --yes
```

Install that build, take the screenshots from it, confirm a push notification
arrives, fill in the listing, then:

```bash
./scripts/release.sh submit 1.0
```

---

## A warning about branches

`codex/release-ui-modernization` forked before the review work landed and does
**not** contain the password sign-in, the removal of GitHub as an iOS door, the
Figma icons, the three-tab bar, or the Google connectors. A build from it fails
review under Guideline 2.1 and 4.8. Its one commit worth having — the push
entitlement wiring — has been cherry-picked onto the branch above.

If that branch carries UI work worth keeping, merge it into a branch based on
`main` and resolve the conflicts, rather than building from it.
