// Dictation via the Web Speech API, mirroring the iOS contract: the
// transcript lands in the field and stays editable — nothing is ever sent
// straight from the microphone.

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function recognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const candidate =
    (window as unknown as { SpeechRecognition?: SpeechRecognitionConstructor })
      .SpeechRecognition ??
    (window as unknown as { webkitSpeechRecognition?: SpeechRecognitionConstructor })
      .webkitSpeechRecognition;
  return candidate ?? null;
}

export const dictationSupported = () => recognitionConstructor() !== null;

export interface Dictation {
  stop: () => void;
}

/**
 * Start dictating. `onTranscript` receives the transcript so far (including
 * interim results) so the field updates live.
 */
export function startDictation(
  onTranscript: (text: string) => void,
  onEnd?: () => void,
  language?: string
): Dictation | null {
  const Recognition = recognitionConstructor();
  if (!Recognition) return null;

  const recognition = new Recognition();
  recognition.lang = language || navigator.language || "en-US";
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onresult = (event) => {
    let transcript = "";
    for (let i = 0; i < event.results.length; i += 1) {
      const alternative = event.results[i]?.[0];
      if (alternative) transcript += alternative.transcript;
    }
    onTranscript(transcript.trim());
  };
  recognition.onerror = () => onEnd?.();
  recognition.onend = () => onEnd?.();

  recognition.start();
  return { stop: () => recognition.stop() };
}
