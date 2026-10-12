import { Button } from "@cloudflare/kumo";
import {
  CircleNotchIcon,
  MicrophoneIcon,
  StopCircleIcon
} from "@phosphor-icons/react";
import type { VoiceCapture } from "./use-voice-capture";

export type { MicMode } from "./use-voice-capture";

type Props = {
  capture: VoiceCapture;
  /** Why the mic can't be used right now, or null when it can. */
  disabledReason: string | null;
};

/**
 * Chat mode's mic: click to record, click again to stop (or stop
 * automatically at 30 s). The transcript goes into the input box.
 */
export function MicButton({ capture, disabledReason }: Props) {
  if (!capture.supported) return null;
  const { status, elapsed } = capture;
  const isRecording = status === "recording";
  const busy = status === "starting" || status === "transcribing";
  const label =
    status === "transcribing"
      ? "Transcribing…"
      : isRecording
        ? "Stop recording"
        : (disabledReason ?? "Speak your message (or hold Ctrl+Space)");

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
        disabled={busy || (!isRecording && disabledReason !== null)}
        icon={
          busy ? (
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
        onClick={
          isRecording ? () => void capture.finish() : () => void capture.start()
        }
      />
    </div>
  );
}
