import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  browserRecognitionSupported,
  startBrowserRecognition,
  startRecording,
  toWavBase64,
  voiceSupported
} from "./voice";

/** "server": record a clip for Whisper/Groq. "browser": the browser listens. */
export type MicMode = "server" | "browser";

export type CaptureStatus = "idle" | "starting" | "recording" | "transcribing";

export type VoiceCapture = {
  supported: boolean;
  status: CaptureStatus;
  /** Seconds since recording started. */
  elapsed: number;
  start: () => Promise<void>;
  /** Stop and transcribe (safe to call while still starting). */
  finish: () => Promise<void>;
};

type Options = {
  mode: MicMode;
  transcribe: (audioBase64: string) => Promise<string>;
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
  /** Called when a capture starts: e.g. stop speech, unlock audio. */
  onStart?: () => void;
};

/** An in-progress capture; `stop()` resolves with the transcript. */
type Capture = { stop: () => Promise<string>; cancel: () => void };

/**
 * One shared recorder for the record button, the Ctrl+Space shortcut and
 * the chat-mode mic, so they can't record over each other.
 */
export function useVoiceCapture(options: Options): VoiceCapture {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const supported = useMemo(
    () =>
      options.mode === "browser"
        ? browserRecognitionSupported()
        : voiceSupported(),
    [options.mode]
  );
  const [status, setStatusState] = useState<CaptureStatus>("idle");
  const statusRef = useRef<CaptureStatus>("idle");
  const setStatus = (next: CaptureStatus) => {
    statusRef.current = next;
    setStatusState(next);
  };
  const [elapsed, setElapsed] = useState(0);
  const capture = useRef<Capture | null>(null);
  // A release (e.g. Ctrl+Space let go) that came before recording started
  const stopRequested = useRef(false);

  useEffect(() => {
    if (status !== "recording") return;
    const startedAt = Date.now();
    setElapsed(0);
    const timer = setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      250
    );
    return () => clearInterval(timer);
  }, [status]);

  // Release the mic if the page goes away mid-recording
  useEffect(() => () => capture.current?.cancel(), []);

  const finish = useCallback(async () => {
    const current = capture.current;
    if (!current) {
      if (statusRef.current === "starting") stopRequested.current = true;
      return;
    }
    capture.current = null;
    setStatus("transcribing");
    const { onTranscript, onError } = optionsRef.current;
    try {
      const text = await current.stop();
      // Whisper turns noise into lone punctuation ("."); that isn't speech
      if (/[\p{L}\p{N}]/u.test(text)) onTranscript(text);
      else
        onError("I didn't catch that. Try again, a little closer to the mic.");
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Couldn't transcribe that recording."
      );
    } finally {
      setStatus("idle");
    }
  }, []);

  const start = useCallback(async () => {
    if (statusRef.current !== "idle") return;
    const { mode, transcribe, onStart, onError } = optionsRef.current;
    onStart?.();
    stopRequested.current = false;
    setStatus("starting");
    const onAutoStop = () => void finish();
    try {
      if (mode === "browser") {
        capture.current = startBrowserRecognition({ onAutoStop });
      } else {
        const clip = await startRecording({ onAutoStop });
        capture.current = {
          stop: async () => transcribe(await toWavBase64(await clip.stop())),
          cancel: clip.cancel
        };
      }
      setStatus("recording");
      if (stopRequested.current) void finish();
    } catch (error) {
      setStatus("idle");
      const blocked =
        error instanceof DOMException && error.name === "NotAllowedError";
      onError(
        blocked
          ? "Microphone access is blocked. Allow it in your browser to use voice."
          : error instanceof Error
            ? error.message
            : "Couldn't start the microphone."
      );
    }
  }, [finish]);

  return { supported, status, elapsed, start, finish };
}
