import { devicesForLogin, removeDevice } from "./db.js";
import { sendPush, isDeadToken, isConfigured } from "./apns.js";

// What a notification is allowed to say.
//
// The lock screen is a public surface. A decision card's summary can carry a
// salary, a client's name, or the terms of a contract, so the alert body is the
// *title* and the routing line only — enough to know it is worth opening,
// never enough to be a leak read over someone's shoulder. The card id rides in
// the payload so the tap can go straight there.

function alertFor(card) {
  const from = card.senderUserID && card.senderUserID !== "deleted-user"
    ? `${card.senderUserID}'s AI`
    : "Your AI";
  return {
    title: card.title || "A decision is waiting",
    subtitle: `${from} → you`,
  };
}

function bodyFor(card, kind) {
  if (kind === "decided") {
    const action = card.decision?.action || card.status;
    return { title: card.title || "Decision made", subtitle: `${card.decision?.actorUserID || "Someone"} · ${action}` };
  }
  return alertFor(card);
}

/// Notify the person a card is now waiting on.
///
/// Never throws and never blocks the caller: the relay hands this to waitUntil
/// after the decision is already stored and broadcast, on the same rule the
/// Notion write follows. A push that fails is a notification nobody got, not a
/// decision nobody made.
export async function notifyCard(env, { card, kind, excludeLogin, badge }) {
  if (!isConfigured(env)) return { sent: 0, skipped: "apns not configured" };

  const recipient = kind === "decided" ? card.senderUserID : card.recipientUserID;
  // Telling you about the thing you just did is noise, and it is the most
  // common shape of a bad notification.
  if (!recipient || recipient === excludeLogin || recipient === "deleted-user") {
    return { sent: 0, skipped: "no one to tell" };
  }

  const devices = await devicesForLogin(env.DB, recipient);
  if (!devices.length) return { sent: 0, skipped: "no devices" };

  const alert = bodyFor(card, kind);
  const payload = {
    aps: {
      alert,
      sound: "default",
      // Set from the recipient's pending count when the caller knows it. An
      // absent badge leaves whatever is on the icon, which is better than
      // guessing and worse than knowing.
      ...(typeof badge === "number" ? { badge } : {}),
      "thread-id": card.id,
    },
    cardId: card.id,
    kind,
  };

  let sent = 0;
  for (const device of devices) {
    const result = await sendPush(env, {
      deviceToken: device.device_token,
      payload,
      // A card that is created and then decided collapses to one notification
      // rather than stacking two contradictory ones.
      collapseId: card.id,
    });
    if (result.ok) {
      sent += 1;
    } else if (isDeadToken(result)) {
      // The app was uninstalled, or the token was reissued. Retrying it forever
      // is how a push table becomes mostly garbage.
      await removeDevice(env.DB, device.device_token);
    }
  }
  return { sent };
}
