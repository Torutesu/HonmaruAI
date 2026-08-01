import { useEffect, useMemo, useState } from "react";
import styles from "./Workbench.module.css";

export interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

interface Props {
  commands: Command[];
  onClose: () => void;
}

export function CommandPalette({ commands, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((command) => command.label.toLowerCase().includes(needle));
  }, [commands, query]);

  useEffect(() => setIndex(0), [query]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") return onClose();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIndex((current) => Math.min(current + 1, matches.length - 1));
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setIndex((current) => Math.max(current - 1, 0));
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const command = matches[index];
      if (command) {
        command.run();
        onClose();
      }
    }
  };

  return (
    <div
      className={styles.paletteVeil}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onClick={onClose}
    >
      <div className={styles.palette} onClick={(event) => event.stopPropagation()}>
        <input
          autoFocus
          className={styles.paletteInput}
          aria-label="Run a command"
          value={query}
          placeholder="Jump to a channel, switch member, run a digest…"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className={styles.paletteList}>
          {matches.length === 0 ? (
            <p className={styles.paletteEmpty}>Nothing matches “{query}”.</p>
          ) : (
            matches.map((command, position) => (
              <button
                key={command.id}
                className={`${styles.paletteItem} ${
                  position === index ? styles.paletteItemActive : ""
                }`}
                onMouseEnter={() => setIndex(position)}
                onClick={() => {
                  command.run();
                  onClose();
                }}
              >
                {command.label}
                {command.hint && <span className={styles.paletteHint}>{command.hint}</span>}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
