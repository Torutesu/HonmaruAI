import { enqueueCardNotification, runCardNotification, deliverOnce, retryable } from './notificationJobs.js';
// Tell the person a card is waiting on, wherever they are.
//
// One entry point, three channels. The relay, the cron and the email webhook
// used to call APNs directly, so a person without the iOS app — which today is
// everyone, because the client ships with push switched off — was told
// nothing. Now the hub looks at who the recipient is, what they read, and what
// can reach them:
//
//   APNs      every iPhone they registered
//   FCM       every Android phone they registered
//   Web Push  every browser or installed PWA they subscribed
//   Email     when nothing above delivered, and they have an address
//
// The alert is composed once, in the recipient's language, and handed to each
// channel. Never throws and never blocks the caller: every call site defers
// this with waitUntil after the decision is stored and broadcast, on the rule
// that a notification that fails is a notification nobody got, not a decision
// nobody made.

import { quietFor } from "./quiet.js";
import {
  devicesForLogin, removeDevice, subscriptionsForLogin, removeSubscription, getUserByLogin,
} from "./db.js";
import { sendPush, isDeadToken, isConfigured as apnsConfigured } from "./apns.js";
import { sendFcm, isDeadFcmToken, isFcmConfigured } from "./fcm.js";
import { sendWebPush, isWebPushConfigured, isDeadSubscription } from "./webpush.js";
import { sendMail, isMailConfigured } from "./mailer.js";
import { composeAlert, composeEmail } from "./notifyCopy.js";
import { localizeStored } from "./localize.js";
import { loadCopy } from "./copy.js";
import { isActive, isIPhone, isAndroid } from "./pushes.js";

export function anyChannelConfigured(env) {
  return apnsConfigured(env) || isFcmConfigured(env) || isWebPushConfigured(env) || isMailConfigured(env);
}

/// Who a notification of this kind is for. A created or nudged card is for the
/// person deciding it; a decided one is for whoever asked.
export function recipientFor(card, kind) {
  return kind === "decided" ? card?.senderUserID : card?.recipientUserID;
}

function deepLink(env, card) {
  if (!env.APP_WEB_URL || !card?.id) return undefined;
  try {
    const url = new URL(env.APP_WEB_URL);
    url.searchParams.set("card", card.id);
    return url.toString();
  } catch {
    // `new URL` throws on anything that is not absolute, and this runs while
    // building the payload of every notification — so one mistyped secret
    // meant nobody was told anything, on any channel, with the failure
    // surfacing as an unhandled rejection in a waitUntil nobody reads.
    // A link nobody can follow is worth losing; the notification is not.
    console.error("APP_WEB_URL is not a URL; notifying without a link");
    return undefined;
  }
}

/// Notify the person a card is now waiting on.
///
/// `kind`: created | decided | nudged | digest. `count` is for a digest.
/// `badge` is the recipient's pending count when the caller knows it — an
/// absent badge leaves whatever is on the icon, which beats guessing.
///
/// `orgId`, when the caller has it, lets the hub put the card into this
/// reader's language first — the one who was mentioned or commented at is not
/// always the one it was translated for when it was made. `payerGithubId` is
/// whose allowance that spends; `announce: false` is for the relay, which
/// broadcasts its own changes rather than calling itself.
export async function notifyCard(env, input) {
  const recipient = input.toLogin || recipientFor(input.card, input.kind);
  if (!recipient || recipient === input.excludeLogin || recipient === 'deleted-user' || !anyChannelConfigured(env)) return notifyCardNow(env, input);
  const id = await enqueueCardNotification(env, input);
  const result = await runCardNotification(env, id, notifyCardNow);
  const {retry, ...publicResult} = result;
  return publicResult;
}

export async function notifyCardNow(env, { card, kind = "created", excludeLogin, badge, count, toLogin, comment, orgId, payerGithubId, announce = true, deliveryJobId }) {
  let retry = false;
  const channels = { apns: 0, fcm: 0, webpush: 0, email: 0 };
  // A comment or a mention names its reader; everything else is read off
  // the card.
  const recipient = toLogin || recipientFor(card, kind);
  // Telling you about the thing you just did is noise, and it is the most
  // common shape of a bad notification.
  if (!recipient || recipient === excludeLogin || recipient === "deleted-user") {
    return { sent: 0, skipped: "no one to tell", channels };
  }
  if (!anyChannelConfigured(env)) return { sent: 0, skipped: "no channel configured", channels };
  // At the app right now, on some device: they see it land there, and hear
  // it. The phone (and the inbox) stay quiet, as in Slack.
  if (kind !== "digest" && await isActive(env.DB, orgId || null, recipient)) return { sent: 0, skipped: "active", channels };
  // Paused, or outside the hours they set: it waits in the feed and Activity.
  if (kind !== "digest") {
    const quiet = await quietFor(env.DB, recipient);
    if (quiet) return { sent: 0, skipped: `quiet:${quiet.reason}`, channels };
  }

  const user = await getUserByLogin(env.DB, recipient);
  const locale = await loadCopy(env, user?.locale || "en", { orgId });
  if (orgId && kind !== "digest") {
    card = await localizeStored(env, orgId, card, { locale, payerGithubId, announce });
  }
  const alert = composeAlert({ card, kind, locale, count, comment });
  const collapseId = card.id;
  let devices = [];
  let subscriptions = [];

  if (apnsConfigured(env) || isFcmConfigured(env)) {
    devices = await devicesForLogin(env.DB, recipient);
  }

  if (apnsConfigured(env)) {
    const payload = {
      aps: {
        alert,
        sound: "default",
        ...(typeof badge === "number" ? { badge } : {}),
        "thread-id": card.id,
      },
      cardId: card.id,
      kind,
      ...(orgId ? { orgId } : {}),
    };
    for (const device of devices.filter(isIPhone)) {
      const result = await deliverOnce(env.DB, deliveryJobId, 'apns', device.device_token, () => sendPush(env, { deviceToken: device.device_token, device, payload, collapseId }));
      retry ||= retryable(result);
      if (result.ok) {
        channels.apns += 1;
      } else if (isDeadToken(result)) {
        // The app was uninstalled, or the token was reissued. Retrying it
        // forever is how a push table becomes mostly garbage.
        await removeDevice(env.DB, device.device_token);
      }
    }
  }

  if (isFcmConfigured(env)) {
    for (const device of devices.filter(isAndroid)) {
      const result = await deliverOnce(env.DB, deliveryJobId, 'fcm', device.device_token, () => sendFcm(env, {
        token: device.device_token,
        title: alert.title,
        text: alert.subtitle,
        // One card, one notification: a nudge replaces the first telling.
        tag: card.id,
        priority: card.priority === "urgent" || card.priority === "high" ? "high" : "normal",
        data: { kind, cardId: card.id, orgId: orgId || null },
      }));
      retry ||= retryable(result);
      if (result.ok) channels.fcm += 1;
      else if (isDeadFcmToken(result)) await removeDevice(env.DB, device.device_token);
    }
  }

  if (isWebPushConfigured(env)) {
    subscriptions = await subscriptionsForLogin(env.DB, recipient);
    const link = deepLink(env, card);
    const payload = {
      title: alert.title,
      body: alert.subtitle,
      cardId: card.id,
      kind,
      tag: card.id,
      ...(orgId ? { orgId } : {}),
      ...(typeof badge === "number" ? { badge } : {}),
      ...(link ? { url: link } : {}),
    };
    for (const subscription of subscriptions) {
      const result = await deliverOnce(env.DB, deliveryJobId, 'webpush', subscription.endpoint, () => sendWebPush(env, {
        subscription, payload, topic: collapseId,
        urgency: card.priority === "urgent" || card.priority === "high" ? "high" : "normal",
      }));
      retry ||= retryable(result);
      if (result.ok) {
        channels.webpush += 1;
      } else if (isDeadSubscription(result)) {
        await removeSubscription(env.DB, subscription.endpoint);
      }
    }
  }

  // The floor. Nothing above reached them — no device, no browser, or every
  // one of them is gone — and they have an address and have not said no.
  const reached = channels.apns + channels.fcm + channels.webpush > 0;
  if (!reached && isMailConfigured(env) && user?.email && Number(user.notify_email ?? 1) !== 0) {
    const mail = composeEmail({ card, kind, locale, count, url: deepLink(env, card), comment });
    const result = await deliverOnce(env.DB, deliveryJobId, 'email', user.email, () => sendMail(env, { to: user.email, ...mail, idempotencyKey: deliveryJobId }));
    retry ||= retryable(result);
    if (result.ok) channels.email += 1;
  }

  const sent = channels.apns + channels.fcm + channels.webpush + channels.email;
  return { sent, channels, locale, retry: retry && channels.email === 0 };
}
