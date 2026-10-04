# Badger

**The agent that nags so you don't have to.** Someone owes you something (a friend, a company, a landlord, a teammate) and chasing them is awkward. Badger researches your rights with Exa, plans a few well-spaced nudges, drafts each one for your approval, sends from its own inbox (AgentMail), waits days for replies (Mastra durable workflow), reads what comes back, and escalates. It can fill a company's web form in a live cloud browser (Kernel).

**Status: work in progress (hackathon build).** Backend loop works; frontend and deployment are not finished.

Stack: Mastra (agents + suspend/resume workflow, Postgres storage), AgentMail, Exa, Kernel, Neon Postgres, Hono, assistant-ui (planned), Fly.io (planned).

Safety is enforced in code: recipient rules, per-case and per-day send caps, content checks, STOP honored forever, AI disclosure on every email, human approval for the first email, escalations and forms.

Dev: copy `.env` values (see `src/env.ts`), `npm install`, `npm run db:migrate`, `npx tsx --env-file=.env src/server.ts`, then `npx tsx scripts/e2e.ts roommate`.
