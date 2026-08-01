// Web Push subscription. The relay owns the notification policy — this only
// obtains a subscription and hands it over.

/**
 * VAPID keys travel as base64url; PushManager wants raw bytes. Getting this
 * conversion wrong is the classic cause of silent subscribe failures.
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  // Backed by a plain ArrayBuffer: PushManager rejects shared buffers.
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

export type PushState =
  | "unsupported"
  | "unconfigured"
  | "denied"
  | "default"
  | "subscribed";

export const pushSupported = () =>
  typeof navigator !== "undefined" &&
  "serviceWorker" in navigator &&
  typeof window !== "undefined" &&
  "PushManager" in window &&
  "Notification" in window;

export async function registerServiceWorker() {
  if (!pushSupported()) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch {
    return null;
  }
}

export async function currentPushState(vapidPublicKey: string | null): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  if (!vapidPublicKey) return "unconfigured";
  if (Notification.permission === "denied") return "denied";

  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (subscription) return "subscribed";

  return Notification.permission === "granted" ? "default" : "default";
}

/**
 * Ask for permission, subscribe, and register with the relay.
 * @returns the resulting state, so the caller can explain what happened.
 */
export async function enablePush(vapidPublicKey: string): Promise<PushState> {
  if (!pushSupported()) return "unsupported";

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "default";

  const registration = (await navigator.serviceWorker.getRegistration()) ??
    (await registerServiceWorker());
  if (!registration) return "unsupported";

  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    }));

  const response = await fetch("/push/register", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ platform: "web", subscription: subscription.toJSON() }),
  });

  if (!response.ok) throw new Error("Could not register for notifications.");
  return "subscribed";
}
