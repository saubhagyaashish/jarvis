// Browser-side voice input: record a short clip, convert it to 16 kHz mono
// WAV (Whisper's native rate, and a format every decoder accepts), and
// base64-encode it for the agent's `transcribe` method.

import { audioContext, levelMeter } from "./audio-levels";

export const MAX_RECORDING_MS = 30_000;

// Loudness of the mic while recording (drives the avatar's listening glow)
let micMeter: (() => number) | null = null;

/** How loud the user is speaking right now (0..1); 0 when not recording. */
export function micLevel(): number {
  return micMeter ? micMeter() : 0;
}
const WHISPER_SAMPLE_RATE = 16_000;

export function voiceSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof MediaRecorder !== "undefined"
  );
}

export type Recording = {
  /** Stop and return the recorded audio. */
  stop: () => Promise<Blob>;
  /** Stop and discard. */
  cancel: () => void;
};

/**
 * Start recording from the microphone. Stops on its own after `maxMs`
 * (calling `onAutoStop`), and always releases the microphone when done.
 */
export async function startRecording(
  options: {
    maxMs?: number;
    onAutoStop?: () => void;
  } = {}
): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const recorder = new MediaRecorder(stream);
  const ctx = audioContext();
  // Measure only: the mic is not connected to the speakers
  micMeter = ctx ? levelMeter(ctx.createMediaStreamSource(stream)) : null;
  const chunks: Blob[] = [];
  recorder.addEventListener("dataavailable", (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  });

  const stopped = new Promise<Blob>((resolve) => {
    recorder.addEventListener("stop", () => {
      micMeter = null;
      for (const track of stream.getTracks()) track.stop();
      resolve(new Blob(chunks, { type: recorder.mimeType }));
    });
  });

  const timer = setTimeout(() => {
    if (recorder.state === "recording") {
      recorder.stop();
      options.onAutoStop?.();
    }
  }, options.maxMs ?? MAX_RECORDING_MS);

  recorder.start();

  return {
    stop: () => {
      clearTimeout(timer);
      if (recorder.state === "recording") recorder.stop();
      return stopped;
    },
    cancel: () => {
      clearTimeout(timer);
      chunks.length = 0;
      if (recorder.state === "recording") recorder.stop();
    }
  };
}

/** Recorded audio (any container the browser recorded) → base64 WAV. */
export async function toWavBase64(audio: Blob): Promise<string> {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await audio.arrayBuffer());
    // Resample to 16 kHz mono by rendering through an offline context
    const frames = Math.ceil(decoded.duration * WHISPER_SAMPLE_RATE);
    const offline = new OfflineAudioContext(1, frames, WHISPER_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return toBase64(encodeWav(rendered.getChannelData(0), WHISPER_SAMPLE_RATE));
  } finally {
    await context.close();
  }
}

/** Mono float samples (-1..1) → a 16-bit PCM WAV file. */
export function encodeWav(
  samples: Float32Array,
  sampleRate: number
): Uint8Array {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

function toBase64(bytes: Uint8Array): string {
  // Chunked, so large clips don't overflow String.fromCharCode's arguments
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// ── Browser speech recognition (last-resort fallback) ──────────────────
// Used only when the server can't transcribe: Workers AI's daily limit is
// in effect and no Groq key is set. Chrome sends this audio to Google.

type RecognitionResult = { isFinal: boolean; 0: { transcript: string } };
type BrowserRecognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult:
    | ((e: {
        resultIndex: number;
        results: ArrayLike<RecognitionResult>;
      }) => void)
    | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

function recognitionConstructor(): (new () => BrowserRecognition) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => BrowserRecognition;
    webkitSpeechRecognition?: new () => BrowserRecognition;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function browserRecognitionSupported(): boolean {
  return recognitionConstructor() !== null;
}

export type Listening = {
  /** Stop listening and return what was heard. */
  stop: () => Promise<string>;
  cancel: () => void;
};

/**
 * Listen with the browser's own speech recognition. Stops on its own after
 * `maxMs` or when the browser ends the session (calling `onAutoStop`).
 */
export function startBrowserRecognition(
  options: {
    maxMs?: number;
    onAutoStop?: () => void;
  } = {}
): Listening {
  const Recognition = recognitionConstructor();
  if (!Recognition) {
    throw new Error("Speech recognition isn't supported in this browser.");
  }
  const recognition = new Recognition();
  recognition.lang = navigator.language || "en-US";
  recognition.continuous = true;
  recognition.interimResults = false;

  const heard: string[] = [];
  let error: string | null = null;
  let stoppedByUs = false;
  const ended = new Promise<string>((resolve, reject) => {
    recognition.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) heard.push(e.results[i][0].transcript);
      }
    };
    recognition.onerror = (e) => {
      error = e.error;
    };
    recognition.onend = () => {
      clearTimeout(timer);
      if (error && error !== "no-speech" && error !== "aborted") {
        reject(
          new Error(
            error === "not-allowed"
              ? "Microphone access is blocked. Allow it in your browser to use voice."
              : `Speech recognition failed (${error}).`
          )
        );
      } else {
        resolve(heard.join(" ").trim());
      }
      if (!stoppedByUs) options.onAutoStop?.();
    };
  });
  // Unhandled rejections are reported where stop() is awaited
  ended.catch(() => {});

  const timer = setTimeout(
    () => recognition.stop(),
    options.maxMs ?? MAX_RECORDING_MS
  );
  recognition.start();

  return {
    stop: () => {
      stoppedByUs = true;
      clearTimeout(timer);
      recognition.stop();
      return ended;
    },
    cancel: () => {
      stoppedByUs = true;
      clearTimeout(timer);
      recognition.abort();
    }
  };
}

/**
 * Whether a transcription error means the server's speech-to-text failed
 * (so the mic should switch to the browser), as opposed to a problem with
 * the recording itself (too long, empty).
 */
export function isServerVoiceFailure(message: string): boolean {
  return !/no audio received|too long/i.test(message);
}
