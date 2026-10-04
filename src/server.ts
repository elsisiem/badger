import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { api } from "./api";
import { pool } from "./db";
import { reconcile, tick } from "./engine";
import { env } from "./env";
import { ensureWebhook } from "./mail";
import { runMigrations } from "./migrate";
import "./mastra"; // registers the Mastra instance (agents, workflow, Postgres storage)

const app = new Hono();

app.use("*", async (c, next) => {
  await next();
  c.res.headers.set("x-content-type-options", "nosniff");
  c.res.headers.set("referrer-policy", "same-origin");
  if (!c.req.path.startsWith("/sim/") && !c.req.path.startsWith("/api/")) {
    c.res.headers.set("x-frame-options", "DENY");
  }
});

app.route("/", api);

// The built React app. Anything that is not an API or sandbox route falls back to index.html (client-side routing).
const webRoot = join(process.cwd(), "dist", "web");
if (existsSync(webRoot)) {
  app.use("/assets/*", serveStatic({ root: "./dist/web" }));
  app.use("/*", serveStatic({ root: "./dist/web" }));
  const index = readFileSync(join(webRoot, "index.html"), "utf8");
  app.get("*", (c) => (c.req.path.startsWith("/api/") ? c.json({ error: "Not found" }, 404) : c.html(index)));
} else {
  app.get("/", (c) => c.text("Badger API is running. Build the web app with `npm run build` or run `npm run dev:web`."));
}

app.onError((e, c) => {
  console.error("[unhandled]", e);
  return c.json({ error: "Something went wrong." }, 500);
});

async function main() {
  await runMigrations();

  // Webhook = instant replies. The reconcile loop below = nothing is ever missed even if a delivery fails.
  const https = env.publicUrl.startsWith("https://");
  if (https) {
    try {
      const w = await ensureWebhook(`${env.publicUrl}/api/webhooks/agentmail`);
      env.agentmailWebhookSecret = w.secret;
      console.log(`[webhook] ${w.created ? "created" : "reusing"} ${w.id}`);
    } catch (e) {
      console.error("[webhook] could not register:", (e as Error).message);
    }
  }

  const inboxes = [env.agentmailInbox, ...Object.values(env.simInboxes)];
  setInterval(() => void tick(), 4000);
  setInterval(() => void reconcile(inboxes), https ? 20_000 : 6000);
  void tick();

  serve({ fetch: app.fetch, port: env.port, hostname: "0.0.0.0" }, (i) => console.log(`Badger listening on :${i.port} (${env.publicUrl})`));

  const stop = async () => {
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((e) => {
  console.error("fatal", e);
  process.exit(1);
});
