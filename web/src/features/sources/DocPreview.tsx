import { useEffect, useState } from "react";
import { api } from "../../core/api";
import { useDocPreview } from "./docPreview";
import styles from "./DocPreview.module.css";

interface Loaded {
  title: string;
  url: string | null;
  excerpt: string;
}

/**
 * The point of one-tap provenance: the document opens *here*, next to the
 * decision, instead of throwing you into another tab to lose your place.
 * "Open in Notion" stays one tap away for when you actually need to edit.
 */
export function DocPreview() {
  const source = useDocPreview((state) => state.source);
  const close = useDocPreview((state) => state.close);

  const [doc, setDoc] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!source) {
      setDoc(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setDoc(null);
    setError(null);

    api
      .notionSource({ pageID: source.notionPageID, url: source.url })
      .then((result) => {
        if (!cancelled) setDoc(result);
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(
          cause instanceof Error ? cause.message : "Could not open that document."
        );
      });

    return () => {
      cancelled = true;
    };
  }, [source]);

  useEffect(() => {
    if (!source) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [source, close]);

  if (!source) return null;

  const href = doc?.url ?? source.url ?? undefined;

  return (
    <div
      className={styles.veil}
      role="dialog"
      aria-modal="true"
      aria-label={source.label}
      onClick={close}
    >
      <div className={styles.sheet} onClick={(event) => event.stopPropagation()}>
        <header className={styles.head}>
          <span className={styles.eyebrow}>Notion</span>
          <h2 className={styles.title}>{doc?.title ?? source.label}</h2>
          <button className={styles.close} onClick={close} aria-label="Close">
            ✕
          </button>
        </header>

        <div className={styles.body}>
          {error ? (
            <p className={styles.state}>{error}</p>
          ) : !doc ? (
            <p className={styles.state}>Opening…</p>
          ) : doc.excerpt ? (
            <pre className={styles.excerpt}>{doc.excerpt}</pre>
          ) : (
            <p className={styles.state}>This page has no text to preview.</p>
          )}
        </div>

        {href && (
          <a className={styles.open} href={href} target="_blank" rel="noreferrer">
            Open in Notion ↗
          </a>
        )}
      </div>
    </div>
  );
}
