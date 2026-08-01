import { useState } from "react";
import { api } from "../../core/api";
import { useSessionStore } from "../../core/stores/session";
import type { Appearance } from "../../core/stores/session";
import styles from "./SettingsScreen.module.css";

const APPEARANCES: { id: Appearance; icon: string; label: string }[] = [
  { id: "system", icon: "◐", label: "System" },
  { id: "dark", icon: "🌙", label: "Dark" },
  { id: "light", icon: "☀", label: "Light" },
];

export function SettingsScreen() {
  const { me, users, repository, githubLogin, appearance, setAppearance, setMe, setOrganization } =
    useSessionStore();

  const [language, setLanguage] = useState(me?.language ?? "");
  const [savingLanguage, setSavingLanguage] = useState(false);
  const [languageSaved, setLanguageSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const saveLanguage = async () => {
    if (!me || !language.trim()) return;
    setSavingLanguage(true);
    setError(null);
    try {
      const result = await api.setLanguage(me.id, language.trim());
      setMe(result.user);
      setOrganization(result.organization.users, {
        nodes: result.organization.nodes,
        edges: result.organization.edges,
      });
      setLanguageSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save your language.");
    } finally {
      setSavingLanguage(false);
    }
  };

  const switchMember = async (userId: string) => {
    setError(null);
    try {
      const result = await api.selectMember(userId);
      setMe(result.user);
      setLanguage(result.user.language ?? "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not switch member.");
    }
  };

  const signOut = async () => {
    await api.signOut().catch(() => {});
    location.reload();
  };

  return (
    <div className={styles.screen}>
      <section className={styles.group}>
        <h2 className={styles.groupTitle}>Appearance</h2>
        <div className={styles.tiles}>
          {APPEARANCES.map((option) => (
            <button
              key={option.id}
              className={`${styles.tile} ${appearance === option.id ? styles.tileActive : ""}`}
              aria-pressed={appearance === option.id}
              onClick={() => setAppearance(option.id)}
            >
              <span className={styles.tileIcon}>{option.icon}</span>
              {option.label}
            </button>
          ))}
        </div>
        <p className={styles.note}>
          System follows your device. Cards, channels and sheets adapt instantly.
        </p>
      </section>

      <section className={styles.group}>
        <h2 className={styles.groupTitle}>Language</h2>
        <div className={styles.field}>
          <input
            value={language}
            placeholder="en / 日本語 / Français …"
            onChange={(event) => {
              setLanguage(event.target.value);
              setLanguageSaved(false);
            }}
          />
          <button disabled={savingLanguage || !language.trim()} onClick={saveLanguage}>
            {savingLanguage ? "…" : languageSaved ? "Saved" : "Save"}
          </button>
        </div>
        <p className={styles.note}>
          Cards, digests, agent replies and AI recommendations arrive translated into your language.
        </p>
      </section>

      <section className={styles.group}>
        <h2 className={styles.groupTitle}>Acting as</h2>
        {users.map((user) => (
          <button
            key={user.id}
            className={`${styles.row} ${user.id === me?.id ? styles.rowActive : ""}`}
            onClick={() => switchMember(user.id)}
          >
            <span className={styles.rowIcon}>{user.id === me?.id ? "●" : "○"}</span>
            {user.name}
            <span className={styles.rowValue}>
              {user.role}
              {user.language ? ` · ${user.language}` : ""}
            </span>
          </button>
        ))}
      </section>

      <section className={styles.group}>
        <h2 className={styles.groupTitle}>Connection</h2>
        <div className={styles.row}>
          <span className={styles.rowIcon}>⑃</span>
          GitHub
          <span className={styles.rowValue}>{githubLogin ?? "not signed in"}</span>
        </div>
        <div className={styles.row}>
          <span className={styles.rowIcon}>◈</span>
          Repository
          <span className={styles.rowValue}>{repository ?? "none selected"}</span>
        </div>
        <button className={`${styles.row} ${styles.danger}`} onClick={signOut}>
          <span className={styles.rowIcon}>⏻</span>
          Sign out
        </button>
      </section>

      <section className={styles.group}>
        <h2 className={styles.groupTitle}>Notifications</h2>
        <p className={styles.note}>
          Only pending high/urgent decisions ring — never chat, notes or digests, and never while
          you're connected.
        </p>
      </section>

      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
