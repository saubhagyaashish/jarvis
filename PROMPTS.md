# Prompts

AI-assisted coding was used to build Jarvis. This file records the prompts, in order, as the assignment asks.

Tool: Claude Code (Claude Opus 5.5), run in this repository.

## Session 1 — design review and Day 1 scaffold (2026-10-12)

1. > brother I want you to go throught the doc.

   Claude reviewed `Jarvis — Architecture on Cloudflare.docx` and listed gaps: UTC cron times, two paths writing facts, missing note and reminder tools, the unspecified Workflow ↔ agent link, the Llama 3.3 context budget, voice details, and deliverables.

2. > So I am doing this beacuse for cloudflare interview which is going to happen. this was the requirement-
   >
   > (pasted the assignment text: LLM, workflow / coordination, chat or voice input, memory or state; prompt history required)

   Claude mapped the design to the four requirements and proposed fixing the doc first, then scaffolding.

3. > yes go ahead, start with the doc fixes

   Claude wrote the fixes into the design doc, then scaffolded the app from `cloudflare/agents-starter`: renamed the agent to `JarvisAgent`, switched the model to `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, and gave each browser its own agent instance.

4. > continue

   (after running `npx wrangler login`) Claude ran the app locally and found that Llama 3.3 replies came back with every token doubled and tool calls failing. The cause: Workers AI streams each chunk in two formats at once (native `response` plus OpenAI-style `choices[0].delta`), and `workers-ai-provider` 3.3.1 reads both. Claude added `src/single-format-ai.ts` to drop the duplicate, added `scripts/smoke-chat.mjs` to test chat over the agent's WebSocket, and deployed to https://jarvis.hiteacher.workers.dev.

5. > I have added plugins of cloudflare as skill from right now you will be understanding of it. could you check it out oncce

   Claude loaded the Cloudflare `agents-sdk` and `workers-best-practices` skills and checked the project against them. It turned on Workers Logs and Traces, advanced `compatibility_date` to the newest the installed runtime supports (2026-07-21), re-tested locally and live, and noted design changes for Day 3: use the SDK's `AgentWorkflow` / `runWorkflow()` with `onWorkflowError`, instead of hand-written RPC between the Workflow and the agent.
