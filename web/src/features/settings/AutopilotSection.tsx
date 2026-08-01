import { useEffect, useState } from "react";
import { api } from "../../core/api";
import { useSessionStore } from "../../core/stores/session";
import type { AutopilotSettings, CardPriority } from "../../core/types";
import styles from "./SettingsScreen.module.css";

const DEFAULTS: AutopilotSettings = {
  enabled: false,
  holdMinutes: 120,
  maxPriority: "high",
  actions: ["approve"],
};

const HOLDS = [60, 120, 240, 480];
const CEILINGS: CardPriority[] = ["low", "medium", "high"];

const holdLabel = (minutes: number) =>
  minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} hours`;

/**
 * Handing decisions to an AI is a delegation of authority, so the control for
 * it says exactly what it will do — and the relay's clamped response, not the
 * request, is what gets shown back.
 */
export function AutopilotSection() {
  const me = useSessionStore((state) => state.me);
  const setMe = useSessionStore((state) => state.setMe);

  const [settings, setSettings] = useState<AutopilotSettings>(DEFAULTS);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setSettings({ ...DEFAULTS, ...(me?.autopilot ?? {}) } as AutopilotSettings);
  }, [me?.id, me?.autopilot]);

  const save = async (changes: Partial<AutopilotSettings>) => {
    if (!me) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.setAutopilot(me.id, { ...settings, ...changes });
      setSettings(result.autopilot);
      setMe(result.user);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save autopilot.");
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    setError(null);
    try {
      const { decided } = await api.runAutopilot();
      setNotice(
        decided === 0 ? "Nothing was ready to decide" : `Your AI decided ${decided} card(s)`
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not run autopilot.");
    }
  };

  return (
    <section className={styles.group}>
      <h2 className={styles.groupTitle}>Autopilot</h2>
      <p className={styles.note}>
        Your AI already predicts how you decide. Turn this on and it may act on those
        predictions — but only on decisions you left sitting, never on anything urgent, and
        every card it touches says so.
      </p>

      <button
        className={`${styles.row} ${settings.enabled ? styles.rowActive : ""}`}
        aria-pressed={settings.enabled}
        disabled={saving}
        onClick={() => save({ enabled: !settings.enabled })}
      >
        <span className={styles.rowIcon}>{settings.enabled ? "●" : "○"}</span>
        {settings.enabled ? "On — your AI can decide for you" : "Off — you decide everything"}
      </button>

      {settings.enabled && (
        <>
          <div className={styles.section}>
            <span className={styles.subTitle}>Wait before acting</span>
            <div className={styles.tiles}>
              {HOLDS.map((minutes) => (
                <button
                  key={minutes}
                  className={`${styles.tile} ${settings.holdMinutes === minutes ? styles.tileActive : ""}`}
                  aria-pressed={settings.holdMinutes === minutes}
                  disabled={saving}
                  onClick={() => save({ holdMinutes: minutes })}
                >
                  {holdLabel(minutes)}
                </button>
              ))}
            </div>
            <p className={styles.note}>
              You always get first refusal — autopilot only handles what is still pending after
              this long.
            </p>
          </div>

          <div className={styles.section}>
            <span className={styles.subTitle}>Highest priority it may decide</span>
            <div className={styles.tiles}>
              {CEILINGS.map((priority) => (
                <button
                  key={priority}
                  className={`${styles.tile} ${settings.maxPriority === priority ? styles.tileActive : ""}`}
                  aria-pressed={settings.maxPriority === priority}
                  disabled={saving}
                  onClick={() => save({ maxPriority: priority })}
                >
                  {priority}
                </button>
              ))}
            </div>
            <p className={styles.note}>Urgent decisions always wait for you.</p>
          </div>

          <button
            className={`${styles.row} ${settings.actions.includes("reject") ? styles.rowActive : ""}`}
            aria-pressed={settings.actions.includes("reject")}
            disabled={saving}
            onClick={() =>
              save({
                actions: settings.actions.includes("reject") ? ["approve"] : ["approve", "reject"],
              })
            }
          >
            <span className={styles.rowIcon}>
              {settings.actions.includes("reject") ? "●" : "○"}
            </span>
            Let it decline too
            <span className={styles.rowValue}>off by default</span>
          </button>
          <p className={styles.note}>
            Approving is recoverable and visible. Declining someone's request without reading it
            is not, so it takes this extra step.
          </p>

          <button className={styles.row} onClick={runNow}>
            <span className={styles.rowIcon}>▶</span>
            Run it now
            {notice && <span className={styles.rowValue}>{notice}</span>}
          </button>
        </>
      )}

      {error && <p className={styles.error}>{error}</p>}
    </section>
  );
}
