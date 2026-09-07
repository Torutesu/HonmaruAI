// Tell the person a card is waiting on, wherever they are.
//
// One entry point, three channels. The relay, the cron and the email webhook
// used to call APNs directly, so a person without the iOS app — which today is
// everyone, because the client ships with push switched off — was told
// nothing. Now the hub looks at who the recipient is, what they read, and what
// can reach them:
//
//   APNs      every iPhone they registered
//   Web Push  every browser or installed PWA they subscribed
//   Email     when nothing above delivered, and they have an address
//
// The alert is composed once, in the recipient's language, and handed to each
// channel. Never throws and never blocks the caller: every call site defers
// this with waitUntil after the decision is stored and broadcast, on the rule
// that a notification that fails is a notification nobody got, not a decision
// nobody made.

import {
  devicesForLogin, removeDevice, subscriptionsForLogin, removeSubscription, getUserByLogin,
} from "./db.js";
import { sendPush, isDeadToken, isConfigured as apnsConfigured } from "./apns.js";
import { sendWebPush, isWebPushConfigured, isDeadSubscription } from "./webpush.js";
import { sendMail, isMailConfigured } from "./mailer.js";
import { composeAlert, composeEmail } from "./notifyCopy.js";

export function anyChannelConfigured(env) {
  return apnsConfigured(env) || isWebPushConfigured(env) || isMailConfigured(env);
}

/// Who a notification of this kind is for. A created or nudged card is for the
/// person deciding it; a decided one is for whoever asked.
export function recipientFor(card, kind) {
  return kind === "decided" ? card?.senderUserID : card?.recipientUserID;
}

function deepLink(env, card) {
  if (!env.APP_WEB_URL || !card?.id) return undefined;
  const url = new URL(env.APP_WEB_URL);
  url.searchParams.set("card", card.id);
  return url.toString();
}

/// Notify the person a card is now waiting on.
///
/// `kind`: created | decided | nudged | digest. `count` is for a digest.
/// `badge` is the recipient's pending count when the caller knows it — an
/// absent badge leaves whatever is on the icon, which beats guessing.
export async function notifyCard(env, { card, kind = "created", excludeLogin, badge, count }) {
  const channels = { apns: 0, webpush: 0, email: 0 };
  const recipient = recipientFor(card, kind);
  // Telling you about the thing you just did is noise, and it is the most
  // common shape of a bad notification.
  if (!recipient || recipient === excludeLogin || recipient === "deleted-user") {
    return { sent: 0, skipped: "no one to tell", channels };
  }
  if (!anyChannelConfigured(env)) return { sent: 0, skipped: "no channel configured", channels };

  const user = await getUserByLogin(env.DB, recipient);
  const locale = user?.locale || "en";
  const alert = composeAlert({ card, kind, locale, count });
  const collapseId = card.id;
  let devices = [];
  let subscriptions = [];

  if (apnsConfigured(env)) {
    devices = await devicesForLogin(env.DB, recipient);
    const payload = {
      aps: {
        alert,
        sound: "default",
        ...(typeof badge === "number" ? { badge } : {}),
        "thread-id": card.id,
      },
      cardId: card.id,
      kind,
    };
    for (const device of devices) {
      const result = await sendPush(env, { deviceToken: device.device_token, payload, collapseId });
      if (result.ok) {
        channels.apns += 1;
      } else if (isDeadToken(result)) {
        // The app was uninstalled, or the token was reissued. Retrying it
        // forever is how a push table becomes mostly garbage.
        await removeDevice(env.DB, device.device_token);
      }
    }
  }

  if (isWebPushConfigured(env)) {
    subscriptions = await subscriptionsForLogin(env.DB, recipient);
    const payload = {
      title: alert.title,
      body: alert.subtitle,
      cardId: card.id,
      kind,
      tag: card.id,
      ...(typeof badge === "number" ? { badge } : {}),
      ...(deepLink(env, card) ? { url: deepLink(env, card) } : {}),
    };
    for (const subscription of subscriptions) {
      const result = await sendWebPush(env, {
        subscription, payload, topic: collapseId,
        urgency: card.priority === "urgent" || card.priority === "high" ? "high" : "normal",
      });
      if (result.ok) {
        channels.webpush += 1;
      } else if (isDeadSubscription(result)) {
        await removeSubscription(env.DB, subscription.endpoint);
      }
    }
  }

  // The floor. Nothing above reached them — no device, no browser, or every
  // one of them is gone — and they have an address and have not said no.
  const reached = channels.apns + channels.webpush > 0;
  if (!reached && isMailConfigured(env) && user?.email && Number(user.notify_email ?? 1) !== 0) {
    const mail = composeEmail({ card, kind, locale, count, url: deepLink(env, card) });
    const result = await sendMail(env, { to: user.email, ...mail });
    if (result.ok) channels.email += 1;
  }

  const sent = channels.apns + channels.webpush + channels.email;
  return { sent, channels, locale };
}
