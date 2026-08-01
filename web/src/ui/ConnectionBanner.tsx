import styles from "./ConnectionBanner.module.css";

interface Props {
  connected: boolean;
  /** When the visible data was last synced, if it came from the cache. */
  restoredAt: string | null;
}

function ago(iso: string) {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/**
 * Says what state you're in rather than leaving a silent stale screen: an
 * offline feed you can read, or a reconnect in progress.
 */
export function ConnectionBanner({ connected, restoredAt }: Props) {
  if (connected) return null;

  return (
    <div className={styles.banner} role="status" aria-live="polite">
      <span className={styles.dot} aria-hidden />
      {restoredAt
        ? `Offline — showing your feed from ${ago(restoredAt)}. Decisions need a connection.`
        : "Reconnecting…"}
    </div>
  );
}
