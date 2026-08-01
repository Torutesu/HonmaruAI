import { useEffect, useRef, useState } from "react";
import { dictationSupported, startDictation, type Dictation } from "../lib/speech";
import styles from "./MicButton.module.css";

interface Props {
  /** Receives the transcript; the caller keeps it editable before sending. */
  onTranscript: (text: string) => void;
  language?: string;
}

export function MicButton({ onTranscript, language }: Props) {
  const [recording, setRecording] = useState(false);
  const sessionRef = useRef<Dictation | null>(null);

  // Never leave the microphone open when the field goes away.
  useEffect(() => () => sessionRef.current?.stop(), []);

  if (!dictationSupported()) return null;

  const toggle = () => {
    if (recording) {
      sessionRef.current?.stop();
      sessionRef.current = null;
      setRecording(false);
      return;
    }

    const session = startDictation(onTranscript, () => {
      sessionRef.current = null;
      setRecording(false);
    }, language);

    if (session) {
      sessionRef.current = session;
      setRecording(true);
    }
  };

  return (
    <button
      type="button"
      className={`${styles.mic} ${recording ? styles.recording : ""}`}
      aria-label={recording ? "Stop dictation" : "Dictate"}
      aria-pressed={recording}
      onClick={toggle}
    >
      {recording ? "◉" : "🎤"}
    </button>
  );
}
