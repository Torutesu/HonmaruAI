import { useState } from "react";
import { api } from "../../core/api";
import type { IngestResponse } from "../../core/api";
import { publishCard } from "../../core/relay";
import { useSessionStore } from "../../core/stores/session";
import styles from "./ComposeBar.module.css";

type Draft = NonNullable<IngestResponse["routing"]> & { sourceText: string; channelID?: string };

interface Props {
  onSent: (message: string) => void;
}

/**
 * The single inbox: whatever you say is triaged by the relay — a decision
 * becomes a draft you review, an update is filed to a channel for you.
 */
export function ComposeBar({ onSent }: Props) {
  const me = useSessionStore((state) => state.me);
  const users = useSessionStore((state) => state.users);
  const organization = useSessionStore((state) => state.organization);

  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameFor = (userID: string) => users.find((u) => u.id === userID)?.name ?? userID;

  const triage = async () => {
    if (!me || !text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.ingest({ text: text.trim(), sender: me, organization });
      if (result.kind === "update") {
        onSent(
          result.channel.isNew
            ? `Filed to new channel #${result.channel.name}`
            : `Filed to #${result.channel.name}`
        );
        setText("");
        setOpen(false);
      } else if (result.routing) {
        setDraft({ ...result.routing, sourceText: text.trim(), channelID: result.channel.id });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Your AI could not process that.");
    } finally {
      setBusy(false);
    }
  };

  const send = () => {
    if (!draft || !me) return;
    // Cards are created over the socket so every client sees it at once; the
    // relay then translates, adds provenance and applies the push policy.
    publishCard({
      id: `card-web-${crypto.randomUUID()}`,
      recipientUserID: draft.recipientUserID,
      senderUserID: me.id,
      type: draft.cardType,
      title: draft.title,
      summary: draft.summary,
      context: draft.context,
      status: "pending",
      priority: draft.priority,
      createdAt: new Date().toISOString(),
      agentRoute: draft.agentRoute,
      routingReason: draft.routingReason,
      sourceInstruction: draft.sourceText,
      labels: draft.labels,
      channelID: draft.channelID,
    });
    onSent(`Routed to ${nameFor(draft.recipientUserID)}`);
    setDraft(null);
    setText("");
    setOpen(false);
  };

  if (!open) {
    return (
      <button className={styles.bar} onClick={() => setOpen(true)}>
        <span className={styles.spark}>✦</span>
        <span>Tell your AI</span>
      </button>
    );
  }

  return (
    <div className={styles.sheet}>
      {draft ? (
        <>
          <p className={styles.eyebrow}>Review card</p>
          {draft.toolCalls?.map((call) => (
            <p className={styles.tool} key={`${call.name}-${call.detail}`}>
              ⑃ {call.label} — {call.detail}
            </p>
          ))}
          <h3 className={styles.draftTitle}>{draft.title}</h3>
          <p className={styles.draftTo}>→ {nameFor(draft.recipientUserID)}</p>
          <p className={styles.draftSummary}>{draft.summary}</p>
          <div className={styles.actions}>
            <button onClick={() => setDraft(null)}>Back</button>
            <button className={styles.send} onClick={send}>
              Send decision card
            </button>
          </div>
        </>
      ) : (
        <>
          <p className={styles.eyebrow}>Your AI</p>
          <p className={styles.hint}>
            Say anything — decisions become cards to review, updates are filed to a channel.
          </p>
          <textarea
            autoFocus
            value={text}
            placeholder="Ask Bob to review the onboarding PR before Friday"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) triage();
              if (event.key === "Escape") setOpen(false);
            }}
          />
          {error && <p className={styles.error}>{error}</p>}
          <div className={styles.actions}>
            <button onClick={() => setOpen(false)}>Cancel</button>
            <button className={styles.send} disabled={busy || !text.trim()} onClick={triage}>
              {busy ? "Thinking…" : "Draft"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
