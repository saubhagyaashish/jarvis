// Server-side speech: Groq Whisper as the speech-to-text backup, and
// Deepgram Aura-2 on Workers AI for spoken replies.

const GROQ_TRANSCRIBE_URL =
  "https://api.groq.com/openai/v1/audio/transcriptions";
export const TTS_MODEL = "@cf/deepgram/aura-2-en";

type SpeechEnv = Env & { GROQ_API_KEY?: string };

export function groqConfigured(env: Env): boolean {
  return Boolean((env as SpeechEnv).GROQ_API_KEY);
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Groq's hosted Whisper (whisper-large-v3-turbo) on a base64 WAV clip. */
export async function transcribeWithGroq(
  env: Env,
  wavBase64: string
): Promise<string> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([base64ToBytes(wavBase64)], { type: "audio/wav" }),
    "speech.wav"
  );
  form.append("model", "whisper-large-v3-turbo");
  form.append("response_format", "json");
  form.append("temperature", "0");
  const response = await fetch(GROQ_TRANSCRIBE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${(env as SpeechEnv).GROQ_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) {
    throw new Error(
      `Groq transcription failed (${response.status}): ${(await response.text()).slice(0, 200)}`
    );
  }
  const result = (await response.json()) as { text?: string };
  return (result.text ?? "").trim();
}

/** Aura-2 → base64 MP3. Accepts a stream, bytes or a (base64) string. */
export async function synthesizeWithAura(
  ai: Ai,
  text: string
): Promise<string> {
  const output: unknown = await ai.run(TTS_MODEL, {
    text,
    speaker: "luna",
    encoding: "mp3"
  });
  if (output instanceof ReadableStream) {
    return bytesToBase64(
      new Uint8Array(await new Response(output).arrayBuffer())
    );
  }
  if (output instanceof ArrayBuffer)
    return bytesToBase64(new Uint8Array(output));
  if (output instanceof Uint8Array) return bytesToBase64(output);
  if (typeof output === "string") {
    // Already base64, or raw binary in a string
    return /^[A-Za-z0-9+/]+=*$/.test(output.slice(0, 200))
      ? output
      : btoa(output);
  }
  const audio = (output as { audio?: unknown } | null)?.audio;
  if (typeof audio === "string") return audio;
  throw new Error("Text-to-speech returned no audio");
}
