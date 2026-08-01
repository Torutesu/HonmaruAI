import { createPrivateKey, sign as cryptoSign } from "node:crypto";
import { connect } from "node:http2";
import { readFileSync, existsSync } from "node:fs";
import webpush from "web-push";

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/**
 * Minimal APNs client: token-based auth (p8 key), HTTP/2, no dependencies.
 * Disabled cleanly when APNS_* env vars are missing.
 */
export function createAPNS(env = process.env) {
  const keyPEM = env.APNS_KEY_P8
    ? env.APNS_KEY_P8.replace(/\\n/g, "\n")
    : env.APNS_KEY_PATH && existsSync(env.APNS_KEY_PATH)
      ? readFileSync(env.APNS_KEY_PATH, "utf8")
      : "";
  const keyID = env.APNS_KEY_ID || "";
  const teamID = env.APNS_TEAM_ID || "";
  const bundleID = env.APNS_BUNDLE_ID || "com.tangle.tiktokforwork";
  const host =
    env.APNS_ENV === "production"
      ? "https://api.push.apple.com"
      : "https://api.sandbox.push.apple.com";

  const configured = Boolean(keyPEM && keyID && teamID);

  let cachedToken = null;
  let cachedAt = 0;

  // APNs requires provider tokens younger than 1h, refreshed no more than
  // every 20 minutes — cache for 50 minutes.
  function authToken(now = Date.now()) {
    if (cachedToken && now - cachedAt < 50 * 60 * 1000) {
      return cachedToken;
    }
    const header = base64url(JSON.stringify({ alg: "ES256", kid: keyID }));
    const payload = base64url(
      JSON.stringify({ iss: teamID, iat: Math.floor(now / 1000) })
    );
    const signingInput = `${header}.${payload}`;
    const key = createPrivateKey(keyPEM);
    const signature = cryptoSign("sha256", Buffer.from(signingInput), {
      key,
      dsaEncoding: "ieee-p1363",
    });
    cachedToken = `${signingInput}.${base64url(signature)}`;
    cachedAt = now;
    return cachedToken;
  }

  function send({ deviceToken, title, body, payload = {} }) {
    if (!configured) {
      return Promise.resolve({ ok: false, reason: "not_configured" });
    }

    return new Promise((resolve) => {
      const client = connect(host);
      client.on("error", (error) => resolve({ ok: false, reason: error.message }));

      const request = client.request({
        ":method": "POST",
        ":path": `/3/device/${deviceToken}`,
        authorization: `bearer ${authToken()}`,
        "apns-topic": bundleID,
        "apns-push-type": "alert",
        "apns-priority": "10",
      });

      let status = 0;
      let responseBody = "";
      request.on("response", (headers) => {
        status = headers[":status"];
      });
      request.on("data", (chunk) => {
        responseBody += chunk;
      });
      request.on("end", () => {
        client.close();
        resolve({
          ok: status === 200,
          status,
          reason: responseBody || undefined,
          prune: status === 410 || /BadDeviceToken|Unregistered/.test(responseBody),
        });
      });
      request.on("error", (error) => {
        client.close();
        resolve({ ok: false, reason: error.message });
      });

      request.end(
        JSON.stringify({
          aps: { alert: { title, body }, sound: "default" },
          ...payload,
        })
      );
    });
  }

  return { configured, authToken, send };
}

/**
 * Web Push (VAPID). Same shape as the APNs client so callers stay
 * platform-agnostic; disabled cleanly without VAPID keys.
 */
export function createWebPush(env = process.env) {
  const publicKey = env.VAPID_PUBLIC_KEY || "";
  const privateKey = env.VAPID_PRIVATE_KEY || "";
  const subject = env.VAPID_SUBJECT || "mailto:relay@tiktokforwork.local";
  const configured = Boolean(publicKey && privateKey);

  if (configured) {
    webpush.setVapidDetails(subject, publicKey, privateKey);
  }

  return {
    configured,
    publicKey,

    async send({ subscription, title, body, payload = {} }) {
      if (!configured) return { ok: false, reason: "not_configured" };
      try {
        await webpush.sendNotification(
          subscription,
          JSON.stringify({ title, body, ...payload })
        );
        return { ok: true };
      } catch (error) {
        const status = error?.statusCode;
        return {
          ok: false,
          status,
          reason: error?.message,
          // 404/410 mean the browser dropped the subscription for good.
          prune: status === 404 || status === 410,
        };
      }
    },
  };
}

/**
 * Push target registry. A target belongs to exactly one user — switching
 * users on a device moves it. Targets are tagged unions:
 *   { platform: "ios", token }  |  { platform: "web", subscription }
 */
export function createPushRegistry(initial) {
  const tokens =
    initial?.tokens && typeof initial.tokens === "object" ? initial.tokens : {};

  function keyOf(target) {
    return target.platform === "web" ? target.subscription?.endpoint : target.token;
  }

  function normalize(entry) {
    // Legacy rows were bare APNs token strings.
    return typeof entry === "string" ? { platform: "ios", token: entry } : entry;
  }

  function detach(key) {
    for (const uid of Object.keys(tokens)) {
      tokens[uid] = (tokens[uid] || [])
        .map(normalize)
        .filter((target) => keyOf(target) !== key);
    }
  }

  return {
    serialize() {
      return { tokens };
    },

    register(userID, deviceToken) {
      const cleanedToken = String(deviceToken || "").trim();
      if (!userID || !cleanedToken || !/^[0-9a-f]{16,}$/i.test(cleanedToken)) {
        return false;
      }
      detach(cleanedToken);
      tokens[userID] = [
        ...(tokens[userID] || []).map(normalize),
        { platform: "ios", token: cleanedToken },
      ];
      return true;
    },

    registerWeb(userID, subscription) {
      const endpoint = subscription?.endpoint;
      if (!userID || typeof endpoint !== "string" || !/^https:\/\//.test(endpoint)) {
        return false;
      }
      if (!subscription?.keys?.p256dh || !subscription?.keys?.auth) return false;

      detach(endpoint);
      tokens[userID] = [
        ...(tokens[userID] || []).map(normalize),
        { platform: "web", subscription },
      ];
      return true;
    },

    targetsFor(userID) {
      return (tokens[userID] || []).map(normalize);
    },

    // Back-compat: APNs device tokens only.
    tokensFor(userID) {
      return this.targetsFor(userID)
        .filter((target) => target.platform === "ios")
        .map((target) => target.token);
    },

    prune(key) {
      detach(key);
    },
  };
}

/**
 * The notification policy IS the product stance: only pending decisions at
 * high/urgent priority ring, and never for someone already looking at
 * their feed. Everything else stays quiet.
 */
export function shouldNotify({ card, onlineUserIDs }) {
  if (!card?.recipientUserID) return false;
  if (card.status && card.status !== "pending") return false;
  if (!["high", "urgent"].includes(card.priority)) return false;
  if ((onlineUserIDs || []).includes(card.recipientUserID)) return false;
  return true;
}
