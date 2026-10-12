import { Button } from "@cloudflare/kumo";
import {
  CircleNotchIcon,
  MicrophoneIcon,
  StopCircleIcon
} from "@phosphor-icons/react";
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

type Props = {
  mode: MicMode;
  /** Why the mic can't be used right now, or null when it can. */
  disabledReason: string | null;
  transcribe: (audioBase64: string) => Promise<string>;
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
  /** Called on every click to start: e.g. stop speech, unlock audio. */
  onStart?: () => void;
};

/** An in-progress capture; `stop()` resolves with the transcript. */
type Capture = { stop: () => Promise<string>; cancel: () => void };

/**
 * Click to record, click again to stop (or stop automatically at 30 s).
 * The transcript goes into the input box for the user to check and send.
 */
export function MicButton({
  mode,
  disabledReason,
  transcribe,
  onTranscript,
  onError,
  onStart
}: Props) {
  const supported = useMemo(
    () =>
      mode === "browser" ? browserRecognitionSupported() : voiceSupported(),
    [mode]
  );
  const [status, setStatus] = useState<"idle" | "recording" | "transcribing">(
    "idle"
  );
  const [elapsed, setElapsed] = useState(0);
  const recording = useRef<Capture | null>(null);

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
  useEffect(() => () => recording.current?.cancel(), []);

  const finish = useCallback(async () => {
    const current = recording.current;
    if (!current) return;
    recording.current = null;
    setStatus("transcribing");
    try {
      const text = await current.stop();
      if (text) onTranscript(text);
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
  }, [onTranscript, onError]);

  const start = useCallback(async () => {
    onStart?.();
    const onAutoStop = () => void finish();
    try {
      if (mode === "browser") {
        recording.current = startBrowserRecognition({ onAutoStop });
      } else {
        const clip = await startRecording({ onAutoStop });
        recording.current = {
          stop: async () => transcribe(await toWavBase64(await clip.stop())),
          cancel: clip.cancel
        };
      }
      setStatus("recording");
    } catch (error) {
      const blocked =
        error instanceof DOMException && error.name === "NotAllowedError";
      onError(
        blocked
          ? "Microphone access is blocked. Allow it in your browser to use voice."
          : "Couldn't start the microphone."
      );
    }
  }, [mode, transcribe, finish, onError, onStart]);

  if (!supported) return null;

  const isRecording = status === "recording";
  const label =
    status === "transcribing"
      ? "Transcribing…"
      : isRecording
        ? "Stop recording"
        : (disabledReason ?? "Speak your message");

  return (
    <div className="flex items-center gap-1.5 mb-0.5">
      {isRecording && (
        <span className="text-xs tabular-nums text-kumo-danger">
          {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
        </span>
      )}
      <Button
        type="button"
        variant={isRecording ? "secondary" : "ghost"}
        shape="square"
        aria-label={label}
        title={label}
        disabled={
          status === "transcribing" || (!isRecording && disabledReason !== null)
        }
        icon={
          status === "transcribing" ? (
            <CircleNotchIcon size={18} className="animate-spin" />
          ) : isRecording ? (
            <StopCircleIcon
              size={18}
              weight="fill"
              className="text-kumo-danger animate-pulse"
            />
          ) : (
            <MicrophoneIcon size={18} />
          )
        }
        onClick={isRecording ? () => void finish() : () => void start()}
      />
    </div>
  );
}
