<p align="center"><img src="public/icon-512.png" width="96" alt="Badger"></p>

# Badger

**The agent that nags so you don't have to.**

Someone owes you something: a friend with your $64, a gym that won't cancel, a landlord who ghosts, a teammate who hasn't done their slides. Chasing them is awkward, so you don't, and you lose the money or the time. Badger does the awkward part.

**Try it now: https://badger-nags.fly.dev** (no sign-up). Click **Watch a 60-second demo** and a whole case plays out on its own, or pick a story and approve each draft yourself.

**Source:** https://github.com/elsisiem/badger

## What it does

1. **Takes the case** by chat (assistant-ui + a Mastra agent) or one click. It finds a company's contact email if you don't have it.
2. **Researches** the company's policy and your rights with **Exa**, keeping only facts that come with an exact quote and a source URL.
3. **Plans** a short ladder of well-spaced nudges that get firmer, never rude.
4. **Drafts each message and waits for your approval** (you can edit it). It sends from its own inbox via **AgentMail**, CCing you.
5. **Waits, durably.** The approval gate is a **Mastra** workflow that suspends and is snapshotted to **Neon** Postgres, so it survives restarts and deploys.
6. **Reads replies.** A promise pushes the clock out. A refusal makes the next nudge firmer. A question for you becomes a task. A "use our web form" reply becomes a step where Badger fills the form in a live cloud browser (**Kernel**) and keeps a screenshot. A "resolved" claim asks *you* to confirm before the case closes.
7. **Nags you, too.** Leave a draft unapproved and Badger reminds you.

### The demo, in plain terms

1. **Pick a story** (a flaky roommate, or a gym that won't let you cancel). The emails are real AgentMail traffic; the other side is a fictional character who replies in seconds.
2. **You stay in charge.** Badger writes every message and stops for your OK. Edit, send, or skip.
3. **Or press Fast-forward.** It skips the waiting and approves for you, so the whole timeline plays out in about a minute. A progress bar shows each step lighting up.

The sandbox clock is 1 day = 20 s. Real cases run on a real clock (days between nudges).

## How the sponsor tools are used

| Tool | Role |
|---|---|
| **Mastra** | Agents (intake, planner, drafter, reply classifier) and a durable `prepare → gate → deliver` workflow whose gate *suspends* until a human decides; Postgres snapshot storage |
| **AgentMail** | Badger's own inbox: sends, threads replies, `extracted_text` for clean reply parsing, Svix-signed webhooks plus a reconcile poll so no reply is ever missed |
| **Exa** | `/search` with `outputSchema` for contacts, policy quotes, deadlines and regulators; every item must carry a quote and URL |
| **Kernel** | Cloud browser (live view + screenshot) to submit a company's web contact form |
| **Neon** | Postgres for cases, events, messages, approvals, plus Mastra workflow snapshots |
| **assistant-ui** | The chat intake, streaming from a Mastra agent; the `open_case` tool call renders as a case card |
| **Fly.io** | Long-lived host (the scheduler and durable workflow need a process that stays up) |

## Safety is enforced in code, not prompts

An agent that emails strangers is also what a spam or harassment tool looks like, so every limit lives in `src/safety.ts` and `src/brain.ts`:

- The **first email, every escalation, every form, and any formal final notice need your approval**. Autopilot can only relax routine follow-ups.
- **Always discloses it is an AI assistant** acting for you, with a case reference and a STOP instruction. A STOP reply ends the case and suppresses that address for every user.
- **Caps:** at most 3 emails to a person (3+ days apart, never above "firm"), 8 to an organization, 12 per user per day, 2 per recipient per day, plus a global kill switch.
- **Recipients:** no system addresses, no other AgentMail inboxes, no sandbox characters outside the demo, suppression list honoured.
- **Content check** on every outbound draft (threats, claims of legal authority, secrets) with a repair pass and a dull template as last resort.
- **The plan is clamped in code.** The model proposes steps; `sanitizePlan` enforces step counts, spacing and that escalation goes only to an address Exa actually found.
- **Forms** are only filled on the counterparty's own domain, over https, and only plain text fields.
- **Untrusted text** from replies is classified, never obeyed.
- Not legal advice, and Badger says so. It cites only what it can quote.

## Run it

```bash
npm install
# .env needs: DATABASE_URL, SESSION_SECRET, ANTHROPIC_API_KEY, AGENTMAIL_API_KEY, EXA_API_KEY, KERNEL_API_KEY
# (see src/env.ts). Mastra needs Node >= 22.13 (this repo pins one locally via the `node` dev dependency).
npm run db:migrate
npm run dev            # http://localhost:8080
npm run build:chat     # rebuild the assistant-ui widget -> public/chat/chat.js
npm test               # unit tests for the safety rules and plan sanitizer
BASE=http://localhost:8080 npx tsx scripts/e2e.ts roommate   # plays a user through a whole case
```

Note: the gym scenario's browser step needs a *publicly reachable* `PUBLIC_URL` (Kernel's browser lives in the cloud), so test it against a deployed instance.

Deploy: `fly apps create`, `fly secrets import < .env`, `fly deploy --remote-only`, then `fly scale count 1`.

## Layout

```
src/brain.ts      agents + planning/drafting/classification prompts + plan sanitizer
src/workflows.ts  Mastra workflow: prepare -> gate (suspend) -> deliver
src/steps.ts      prepare/approve/deliver logic, scheduling the next wake-up
src/engine.ts     case lifecycle, scheduler tick, approvals, reply handling
src/safety.ts     every rule listed above
src/research.ts   Exa
src/kernel.ts     Kernel browser form-filling
src/mail.ts       AgentMail client      src/sim.ts  the sandbox cast + fake gym website
src/intake.ts     chat agent + tools    src/api.ts  HTTP API, webhook, chat stream
public/           the app (vanilla JS) and the built assistant-ui widget
```

## Roadmap

SMS and WhatsApp channels, voice calls for the people who ignore email, shared team cases ("who hasn't done their slides"), a daily briefing via a Mastra scheduled workflow, and a landlord/repair-request playbook with local-law citations.

Built for the Personal Agents hackathon.
