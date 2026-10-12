// Playing spoken replies in the browser: Aura-2 MP3 from the server, or the
// browser's own speechSynthesis as the fallback. Also reports how loud the
// speech is right now, which drives the avatar's mouth.

import { audioContext, levelMeter } from "./audio-levels";

type Speech =
  | { kind: "audio"; audio: HTMLAudioElement; meter: (() => number) | null }
  | { kind: "browser" }
  | null;

let speech: Speech = null;
let lastWordAt = 0; // browser voice: when the last word started

// 44-byte silent WAV, played from a click to unlock audio on iOS/Safari
const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

export function browserSpeechSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    typeof SpeechSynthesisUtterance !== "undefined"
  );
}

export function stopSpeaking() {
  if (speech?.kind === "audio") speech.audio.pause();
  speech = null;
  if (browserSpeechSupported()) speechSynthesis.cancel();
}

/**
 * Browsers only allow audio that follows a user gesture (strictly so on
 * iOS). Call this from a click so a reply that arrives later can play.
 */
export function unlockAudio() {
  try {
    audioContext();
    new Audio(SILENT_WAV).play().catch(() => {});
    if (browserSpeechSupported()) {
      speechSynthesis.speak(new SpeechSynthesisUtterance(""));
    }
  } catch {
    // Nothing to unlock in this browser
  }
}

/**
 * How loud Jarvis is speaking right now (0..1). Measured from the audio for
 * Aura-2; the browser's own voice can't be measured, so it's simulated,
 * with a pulse at the start of each word.
 */
export function speechLevel(): number {
  if (!speech) return 0;
  if (speech.kind === "audio" && speech.meter) return speech.meter();
  const t = performance.now() / 1000;
  const wordPulse = Math.max(0, 1 - (performance.now() - lastWordAt) / 180);
  return Math.min(
    1,
    0.2 + 0.25 * Math.abs(Math.sin(t * 13)) + 0.45 * wordPulse
  );
}

/** Play base64 MP3 (from Aura-2); resolves when it finishes or is stopped. */
export function playMp3(base64: string): Promise<void> {
  stopSpeaking();
  const audio = new Audio(`data:audio/mpeg;base64,${base64}`);
  let meter: (() => number) | null = null;
  const ctx = audioContext();
  if (ctx) {
    // Route through the AudioContext so the loudness can be measured
    const source = ctx.createMediaElementSource(audio);
    source.connect(ctx.destination);
    meter = levelMeter(source);
  }
  const current: Speech = { kind: "audio", audio, meter };
  speech = current;
  return new Promise((resolve, reject) => {
    const done = () => {
      if (speech === current) speech = null;
      resolve();
    };
    audio.onended = done;
    audio.onpause = done;
    audio.onerror = () => {
      if (speech === current) speech = null;
      reject(new Error("Couldn't play the audio."));
    };
    audio.play().catch((error) => {
      if (speech === current) speech = null;
      reject(error);
    });
  });
}

/** Speak with the browser's own voice; resolves when done or stopped. */
export function speakWithBrowser(text: string): Promise<void> {
  stopSpeaking();
  if (!browserSpeechSupported() || !text) return Promise.resolve();
  // One utterance per sentence: Chrome cuts long utterances off
  const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [text];
  const voice = pickVoice();
  const current: Speech = { kind: "browser" };
  speech = current;
  return new Promise((resolve) => {
    const done = () => {
      if (speech === current) speech = null;
      resolve();
    };
    sentences.forEach((sentence, i) => {
      const utterance = new SpeechSynthesisUtterance(sentence.trim());
      if (voice) utterance.voice = voice;
      utterance.lang = voice?.lang ?? navigator.language;
      utterance.onboundary = () => {
        lastWordAt = performance.now();
      };
      if (i === sentences.length - 1) {
        utterance.onend = done;
        utterance.onerror = done;
      }
      speechSynthesis.speak(utterance);
    });
  });
}

/** A voice for the user's language (e.g. en-IN), else the default. */
function pickVoice(): SpeechSynthesisVoice | null {
  const voices = speechSynthesis.getVoices();
  const lang = navigator.language || "en-US";
  return (
    voices.find((v) => v.lang === lang) ??
    voices.find((v) => v.lang.startsWith(lang.split("-")[0])) ??
    null
  );
}
