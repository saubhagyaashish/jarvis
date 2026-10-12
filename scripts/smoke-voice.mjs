// Phase 3 smoke test: speech-to-text through the agent's `transcribe` method.
// macOS only: generates speech with `say` and converts it with `afconvert`
// to the same 16 kHz mono WAV the browser sends.
//
// Usage: node scripts/smoke-voice.mjs [baseUrl]

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentClient, checker } from "./agent-test-client.mjs";

const baseUrl = process.argv[2] ?? "http://localhost:5173";
const { wsUrl, rpc, state } = agentClient(
  baseUrl,
  `smoke-voice-${crypto.randomUUID()}`
);
const { check, finish } = checker();

function speechAsWavBase64(text) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-voice-"));
  try {
    const aiff = join(dir, "speech.aiff");
    const wav = join(dir, "speech.wav");
    execFileSync("say", ["-o", aiff, text]);
    execFileSync("afconvert", [
      "-f",
      "WAVE",
      "-d",
      "LEI16@16000",
      "-c",
      "1",
      aiff,
      wav
    ]);
    return readFileSync(wav).toString("base64");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function rejection(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error.message;
  }
}

console.log(`instance: ${wsUrl}\n`);

const spoken = "Remind me in five minutes to drink water";
const audio = speechAsWavBase64(spoken);
console.log(
  `  spoken: "${spoken}" (${Math.round(audio.length / 1024)} KB base64)`
);
const setup = await rpc("getVoiceSetup");
console.log(`  voice setup: ${JSON.stringify(setup)}`);
const limitActive = async () => {
  const limit = (await state())?.aiLimit;
  return Boolean(limit && Date.parse(limit.until) > Date.now());
};

// Speech → text: Whisper on Workers AI, or Groq while the limit is in effect
try {
  const text = await rpc("transcribe", audio);
  console.log(`  heard:  "${text}"`);
  check(
    `transcribes speech (${(await limitActive()) ? "Groq" : "Workers AI"})`,
    /drink/i.test(text) && /water/i.test(text)
  );
} catch (error) {
  const limited = await limitActive();
  check(
    limited && !setup.groq
      ? "limited with no Groq key: server declines, browser listens instead"
      : "transcribes speech",
    limited && !setup.groq && /unavailable/i.test(error.message),
    error.message
  );
}

// Text → speech: Aura-2 MP3, or the browser's voice while limited
const reply = await rpc("speak", "**Hello** from Jarvis. Here is your answer.");
if ("audio" in reply) {
  const bytes = Buffer.from(reply.audio, "base64");
  const isMp3 =
    bytes.subarray(0, 3).toString() === "ID3" ||
    (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  check(
    "speak returns MP3 from Aura-2",
    isMp3 && bytes.length > 1000,
    `${bytes.length} bytes`
  );
} else {
  check(
    "speak falls back to the browser's voice while limited",
    reply.fallback === "browser" && (await limitActive()),
    JSON.stringify(reply)
  );
}

check(
  "rejects empty audio",
  /no audio/i.test((await rejection(rpc("transcribe", ""))) ?? "")
);
check(
  "rejects oversized audio",
  /too long/i.test(
    (await rejection(rpc("transcribe", "A".repeat(2_100_000)))) ?? ""
  )
);

finish();
