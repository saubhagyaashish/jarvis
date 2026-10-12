# How I built Jarvis with AI

I built Jarvis with Claude Code (Claude Opus 5.5) as a pair programmer, working in this repo. The assignment asks for the prompt history, so every prompt I sent is below, in order. They're quoted as I typed them; I've only fixed spelling. I talked to it like a teammate rather than writing polished prompts.

The prompts alone don't show much of how the project was actually shaped. Claude often came back with questions and options, and I made the calls. So under each step I've noted what I decided and why, and there's a summary of the main trade-offs at the end.

I'd written the original design doc, `Jarvis — Architecture on Cloudflare.docx`, before these sessions.

---

## 1. Reviewing the design

> brother I want you to go through the doc.

> So I am doing this because for Cloudflare interview which is going to happen. this was the requirement-
> _(pasted the assignment: LLM, workflow/coordination, chat or voice input, memory or state; prompt history required)_

> yes go ahead, start with the doc fixes

I wanted a second pair of eyes on the design before writing any code. The review caught things I'd missed:

- Cron schedules run in UTC, so "08:00" would have fired at 1:30 pm IST.
- Two separate paths could both write facts, which would create duplicates.
- The design never said how the Workflow talks back to the agent.

I had those written into the doc before starting.

## 2. First deploy

> continue

_(after I ran `npx wrangler login`)_

I started from Cloudflare's `agents-starter`, switched it to Llama 3.3 on Workers AI, and gave each browser its own agent instance, so visitors don't share a chat. The first local run showed every token doubled. Workers AI was streaming each chunk in two formats at once, and the provider library read both. We fixed it with a small wrapper around the AI binding and deployed.

> I have added plugins of cloudflare as skill from right now you will be understanding of it. could you check it out once

I installed Cloudflare's agent skills so the work would follow their current docs rather than older knowledge. That check turned on logging and traces, and showed the SDK has built-in Workflow support (`AgentWorkflow`), which I used later instead of wiring it by hand.

## 3. Planning in phases

> cool lets plan in phases what are the things we need to do

I split the work into memory → the agent acting on its own → voice → polish, with a deploy and a test at the end of each phase. That way there was always a working version live.

## 4. Phase 1: memory

> Move to phase 1. delete starter leftovers like the demo tools.. the mcp panel and image uploads.. and continue phase 1 development

Jarvis stores facts, tasks and notes in each user's own SQLite. Facts are extracted in the background after each reply, so the reply itself isn't slowed down. Deleting a fact needs my approval. An end-to-end test caught Llama saving facts as notes as well, which meant a "forgotten" fact could survive in a note. We fixed that.

## 5. Phase 2: briefing and reminders

> /plan and lets go phase 2

Decisions I made when asked:

- **The briefing goes to both the chat and the side panel.** It's more noticeable as a message from Jarvis.
- **No git yet.** I wanted to get the features in first. In hindsight, I'd start git earlier.

The morning briefing is a durable Workflow (load context → compose → save), so a failed AI call retries one step instead of the whole run, and each run is visible in the dashboard. This phase surfaced the most interesting bugs:

- **My test client never sent chat history**, so the earlier tests had passed too easily.
- **Once history was real, Llama 3.3 started repeating tool calls**, adding the same task five times. We fixed it by rebuilding the prompt before every step, forcing a text answer after a successful tool call, and dropping old tool calls from the history.

## 6. Hitting the free tier

> do one more thing. display on the UI also that the free tier cloudflare limit has ended. also could I use one ollama model. I have the keys with me? so if the free tier is over switch to ollama model. what do you say?

> cool done. lets move ahead

Testing used up the Workers AI free tier for the day. I kept Llama 3.3 on Workers AI as the main model and added Ollama Cloud only as a backup that takes over when the daily limit is hit, plus a banner so the user knows why. The key lives in a Wrangler secret; I set it myself, so it never went through the chat.

## 7. Phase 3: voice input

> /plan lets build phase 3

Microphone → Whisper on Workers AI → the text lands in the input box so it can be checked before sending. Whisper's accepted formats aren't documented, so the browser converts every recording to 16 kHz WAV, which works everywhere.

## 8. Integrations: OpenAPI and MCP

> I want add one more feature that if I give api spec an openai _[OpenAPI]_ spec maybe it will can convert to mcp and can use it. I think there are already opensource code on github take an example and do the stuff. add this as an feature. also I can add any mcps urls that it can also use and do the stuff. could you help me out in this? it will save it. we can also delete manually.

Decisions I made when asked:

- **Turn each OpenAPI operation into an MCP-style tool inside Jarvis**, following how open-source converters do it, rather than hosting a separate MCP server. It's simpler, and it avoids exposing an endpoint that carries my API keys.
- **Approval only for calls that could change data.** Read-only calls (GET, or MCP tools marked read-only) run straight away. Writes ask first, so a malicious API response can't trick Jarvis into doing something.

The limits: 15 external tools in total, and large schemas trimmed, because Llama 3.3 gets less reliable with many tools and has a 24K-token context.

## 9. Voice replies and backups

> I got this- Cloudflare Workers AI's free daily limit is used up. Jarvis is answering with a backup model (Ollama · gpt-oss:120b) until it resets at 05:30 AM. The Ollama has many more models. We can choose a models which can understand voice maybe. the voice it is not able to understand. I want reply also in voice. what we are lacking. lets discuss first

> could you also look over internet for me are there any other alternatives voice packs, models free tier models etc.. conversational ai etc

> 1. yes do it. 2. yeah sounds good 3. nope we not need this

_(answering three questions: use Groq as the speech-to-text backup → yes; Aura-2 for spoken replies with the browser's voice as backup → yes; Hindi support → not needed)_

I wanted to understand the options before building. None of Ollama's models accept audio, so voice needed its own backups. I chose to keep a speech-to-text → Jarvis → text-to-speech pipeline instead of a speech-to-speech model, so memory and tools stay in Jarvis. Each direction runs Cloudflare first, then a free backup.

> added the groq key, test it

> add the auto switch to browser if groq fails

If server transcription fails, the mic switches to the browser's own recognition. I rejected running it alongside every recording: Chrome sends that audio to Google, and avoiding that was the point of using Groq.

## 10. The voice screen

> cool I tested it. I didn't like the UI. I want some thing like a cartoon model/anime model speaking to me. changing expression. there should be two modes switch to voice or simple chat. and it will be having voice and chat history. the main will be the voice screen only. where I can talk. Few words what it will say like Hey Master welcome back. How you doing. I want the character facial changes also while speaking. If I need to speak the shortcut button will be holding ctrl+space button. or I will click on screen on record button something then stop. I want a cool UI. more like I am really talking to something.

Decisions I made when asked:

- **A 3D anime character (VRM)** rather than a 2D drawing. The characters are VRoid's sample models, released as CC0. I checked the licence inside each file before using them.
- **Spoken messages are sent automatically**, so it feels like a conversation rather than a form.

The character blinks, breathes, follows you with its eyes, changes expression while listening, thinking or speaking, and moves its mouth with the loudness of the reply audio.

> Uncaught TypeError: l is not a function _(pasted the browser stack trace)_ also the notification which is coming nothing it is telling it is only coming as a pop up

The crash came from an effect that returned the result of `scrollIntoView()`, which newer Chrome versions return as a Promise; React then tried to call it as a cleanup function. I also wanted reminders spoken, not just shown, so Jarvis now announces them out loud.

## 11. Wrapping up

> what is in phase 4

> do these steps in phase 4 - 6 -prompts md update this file remove rubbish questions and change it with good questions, design question tradeoffs etc and it should sound like human

This is where this file was reorganised. The prompts stayed exactly as I typed them, and I replaced the long AI-written summaries with my own notes on what I decided.

> proceed with phase 4. github init and commits are already done

I'd set up the GitHub repo and commits myself. This step produced the README (with screenshots from a seeded demo), updated the design doc to match the final build, and ran a cleanup pass and the full set of smoke tests: chat, memory 10/10, briefing 14/14, voice 4/4, integrations 10/10.

---

## Design decisions and trade-offs

- **One agent (Durable Object) per user.** Each user's data has exactly one writer, so there are no race conditions and no locking, and it scales by adding instances. The cost is no cross-user queries, which Jarvis doesn't need.
- **Synced state vs SQL.** Small things the UI must update instantly (briefing status, reminder inbox, the free-tier limit) live in synced state. Things that grow (facts, tasks, notes) live in SQL, and the panel refetches them when the agent says something changed.
- **Fact extraction after the reply.** The reply is never slowed down, and the job retries if Workers AI fails. The cost is that a new fact shows up a second later. The extractor sees the existing facts, so "I don't eat meat" isn't saved again after "I'm vegetarian".
- **A Workflow for the briefing** rather than running it inside the agent: per-step retries, and runs I can inspect.
- **Times in the user's timezone.** Cron runs in UTC, so local times are converted; daylight saving can drift by an hour until the briefing is set again.
- **Human approval for anything destructive or external that writes data.** It's the main protection against a tool result manipulating the model.
- **Working around Llama 3.3's limits rather than switching models**, since the assignment recommends it:
  - few tools
  - short IDs the model can copy back reliably
  - a fresh prompt before every step
  - a stream filter for "I don't need to call any function" replies
- **Cloudflare first, backups second:**
  - Llama 3.3 → Ollama
  - Whisper → Groq → the browser
  - Aura-2 → the browser

  The free tier is small (two test runs use it up), so the app has to keep working when it runs out, and say so.

- **Privacy over convenience in voice.** The browser's recognition is only a last resort, because Chrome sends that audio to Google.
- **Cost-aware speech.** Aura-2 costs about 2,700 neurons per 1,000 characters, so spoken replies are capped at about 600 characters.
- **A heavier page for a better experience.** Each character is a 15–19 MB download, but it only loads on the voice screen, so chat mode stays light.
