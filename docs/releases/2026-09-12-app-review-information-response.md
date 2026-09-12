# App Review information response — 2026-09-12

This response is for App Store version 1.0 after the Guideline 2.1
Information Needed request. Do not say that the recording is attached until the final
physical-device video has actually been uploaded.

## Recording checklist

Record one continuous video on a supported physical iPhone running the latest public
iOS release. Begin with the app closed and show:

1. Launch Honmaru AI.
2. Create a disposable account, then sign in with a password.
3. Create a request from text or voice, review the AI-created draft, choose a teammate,
   and send it.
4. Open a received request and approve it or reply to it.
5. Open Profile > Plan and usage > Upgrade to Pro. Show both plans, their localized
   prices and periods, Terms of Use, Privacy Policy, and Restore purchases.
6. Complete a sandbox purchase and restore, or show the already-qualified purchase and
   restore paths without exposing Apple ID information.
7. Open Profile > Workspace > Delete account and complete deletion of the disposable
   account. Never delete `appreview@honmaruai.com`.

Use a filename such as `honmaruai-build38-iphone-physical-review.mp4`. Before upload,
check that no personal notification, Apple ID, password, or unrelated customer data is
visible.

## App Review Information notes

Replace the bracketed device information and the build number after the recording and
new TestFlight build are complete.

```text
PHYSICAL-DEVICE QA
The attached screen recording was captured on a physical [IPHONE MODEL] running [IOS VERSION] and demonstrates build [BUILD NUMBER] from launch through the typical workflow, subscription presentation, purchase restoration, and account deletion.

1. PURPOSE AND TARGET AUDIENCE
Honmaru AI is a productivity app for small teams, managers, project leads, and cross-functional organizations. It turns a spoken or written request into a structured decision card. The user reviews and edits the AI-created draft, chooses a teammate, and explicitly sends it. The app reduces repeated explanations and makes approvals, replies, revisions, and decision history easier to follow.

2. ACCESS AND MAIN FEATURES
Use the non-expiring demo credentials in the dedicated App Review Information username and password fields. From the first screen, tap “I already have an account,” then “Use a password instead.” GitHub is not required. The center tab opens the request composer. Enter text or use voice, review the generated draft, select a teammate, and tap “Send request.” Team setup and invite codes are under Profile > Team. A sample demo is also available before sign-in and does not send real requests.

The app has no public or anonymous social feed. Requests and replies are private business content visible only to authenticated members of an invite-only workspace. Content is not publicly discoverable and users cannot contact random users outside their workspace.

3. EXTERNAL SERVICES
Cloudflare Workers and D1 provide the authenticated API and data storage. OpenAI organizes request drafts and assists with routing. Resend delivers email login codes and notifications. Apple Push Notification service delivers push notifications. RevenueCat and Apple StoreKit manage subscription status and purchases. GitHub is an optional integration for a workspace owner who chooses to connect an authorized repository; it is not required to use or review the iOS app.

4. REGIONS
Core functionality is consistent in all supported regions. The app supports Japanese and English. Subscription prices and currency are localized by the App Store for the reviewer’s storefront.

5. REGULATED INDUSTRIES AND THIRD-PARTY MATERIAL
The app is not a medical, financial, legal, gambling, or other regulated-industry service. It does not provide protected third-party media or licensed catalog content. Users may connect only GitHub repositories and team content they are authorized to access.

6. IN-APP PURCHASES
Honmaru AI offers two auto-renewable subscriptions: Pro Monthly (one month; currently USD 10.00 in the United States) and Pro Yearly (one year; currently USD 96.00 in the United States). Storefront-localized prices are shown in the app. Pro provides unlimited AI routing, the organization graph, and priority delivery. The free plan remains usable with three AI-routed decisions per day, followed by keyword routing.

To reach the purchase flow: Profile > Plan and usage > Upgrade to Pro. The paywall displays each plan’s title, period, localized price, Terms of Use, Privacy Policy, and Restore purchases. Existing subscribers can also restore from Profile > Plan and usage.

7. DISTRIBUTION
Honmaru AI is a generally available SaaS product for independent teams and organizations. It is not restricted to one employer, client, or preselected business.
```

## Resolution Center reply

Attach the same physical-device recording to the reply, then paste:

```text
Hello App Review,

Thank you for the request. We completed physical-device QA on a supported [IPHONE MODEL] running [IOS VERSION]. The attached recording begins with launching Honmaru AI and demonstrates the typical request workflow, password registration and login, subscription plans and restoration, and in-app account deletion.

We have also copied the complete purpose, audience, access instructions, external-service list, regional information, regulatory/content-rights statement, distribution model, and In-App Purchase details into the App Review Information Notes field as requested.

The non-expiring review account remains available through the username and password fields in App Review Information. GitHub is optional and is not required for review.

Honmaru AI has no public or anonymous social feed. Requests and replies are private business content visible only to authenticated members of an invite-only workspace and are not publicly discoverable.

Please let us know if any additional information is needed.
```

## Submission order

1. Validate the new build on a physical iPhone and record the video.
2. Upload the recording to App Review Information and attach it to the Resolution Center
   reply.
3. Update App Review Information Notes with the finalized text above.
4. Send the Resolution Center reply.
5. Replace the rejected app-version item with the new build while retaining the existing
   Pro Monthly and Pro Yearly subscription items.
6. Resubmit and verify `WAITING_FOR_REVIEW`.
