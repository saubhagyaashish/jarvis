// Playing spoken replies in the browser: Aura-2 MP3 from the server, or the
// browser's own speechSynthesis as the fallback.

let currentAudio: HTMLAudioElement | null = null;

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
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if (browserSpeechSupported()) speechSynthesis.cancel();
}

/**
 * Browsers only allow audio that follows a user gesture (strictly so on
 * iOS). Call this from a click so a reply that arrives later can play.
 */
export function unlockAudio() {
  try {
    new Audio(SILENT_WAV).play().catch(() => {});
    if (browserSpeechSupported()) {
      speechSynthesis.speak(new SpeechSynthesisUtterance(""));
    }
  } catch {
    // Nothing to unlock in this browser
  }
}

/** Play base64 MP3 (from Aura-2); resolves when it finishes or is stopped. */
export function playMp3(base64: string): Promise<void> {
  stopSpeaking();
  const audio = new Audio(`data:audio/mpeg;base64,${base64}`);
  currentAudio = audio;
  return new Promise((resolve, reject) => {
    audio.onended = () => resolve();
    audio.onpause = () => resolve();
    audio.onerror = () => reject(new Error("Couldn't play the audio."));
    audio.play().catch(reject);
  });
}

/** Speak with the browser's own voice; resolves when done or stopped. */
export function speakWithBrowser(text: string): Promise<void> {
  stopSpeaking();
  if (!browserSpeechSupported() || !text) return Promise.resolve();
  // One utterance per sentence: Chrome cuts long utterances off
  const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [text];
  const voice = pickVoice();
  return new Promise((resolve) => {
    sentences.forEach((sentence, i) => {
      const utterance = new SpeechSynthesisUtterance(sentence.trim());
      if (voice) utterance.voice = voice;
      utterance.lang = voice?.lang ?? navigator.language;
      if (i === sentences.length - 1) {
        utterance.onend = () => resolve();
        utterance.onerror = () => resolve();
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
