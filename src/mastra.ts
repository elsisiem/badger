import { Mastra } from "@mastra/core/mastra";
import { PostgresStore } from "@mastra/pg";
import { classifierAgent, drafterAgent, plannerAgent, queryAgent } from "./brain";
import { env } from "./env";
import { intakeAgent } from "./intake";
import { setMastra } from "./registry";
import { nudgeStepWorkflow } from "./workflows";

/**
 * One Mastra instance: the agents (so runs are traced and inspectable), the durable workflow, and Postgres storage
 * (Neon) for workflow snapshots, which is what lets a pending approval survive restarts and deploys.
 */
export const mastra = new Mastra({
  agents: { intake: intakeAgent, planner: plannerAgent, drafter: drafterAgent, classifier: classifierAgent, sandbox: queryAgent },
  workflows: { nudgeStep: nudgeStepWorkflow },
  storage: new PostgresStore({ id: "badger-storage", connectionString: stripSslMode(env.databaseUrl), ssl: { rejectUnauthorized: false } } as any),
});

setMastra(mastra);

/** pg treats sslmode=require as verify-full and warns; we pass ssl explicitly instead. */
export function stripSslMode(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete("sslmode");
    return u.toString();
  } catch {
    return url;
  }
}
