/** Single place that reads configuration. Everything secret comes from the environment (.env locally, `fly secrets` in prod). */
const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing required environment variable ${k}`);
  return v;
};
const opt = (k: string, d = ""): string => process.env[k] ?? d;

export const env = {
  port: Number(opt("PORT", "8080")),
  publicUrl: opt("PUBLIC_URL", "http://localhost:8080").replace(/\/$/, ""),
  databaseUrl: need("DATABASE_URL"),
  sessionSecret: need("SESSION_SECRET"),
  adminSecret: opt("ADMIN_SECRET"),
  anthropicKey: need("ANTHROPIC_API_KEY"),
  exaKey: opt("EXA_API_KEY"),
  kernelKey: opt("KERNEL_API_KEY"),
  agentmailKey: need("AGENTMAIL_API_KEY"),
  agentmailInbox: opt("AGENTMAIL_INBOX", "askbadger@agentmail.to"),
  agentmailWebhookSecret: opt("AGENTMAIL_WEBHOOK_SECRET") as string,
  simInboxes: {
    gym: opt("SIM_GYM_INBOX", "sunnyside-gym@agentmail.to"),
    roommate: opt("SIM_ROOMMATE_INBOX", "alex-roommate@agentmail.to"),
    landlord: opt("SIM_LANDLORD_INBOX", "oakview-property@agentmail.to"),
  },
  /** Global kill switch: when "false" Badger drafts and plans but sends nothing. */
  sendingEnabled: opt("SENDING_ENABLED", "true") !== "false",
  /** Fast-forward for sandbox demos: one "day" lasts 24h / this. */
  demoClockScale: Number(opt("DEMO_CLOCK_SCALE", "4320")), // 1 day = 20 seconds
  modelSmart: opt("MODEL_SMART", "anthropic/claude-sonnet-5-5"),
  modelFast: opt("MODEL_FAST", "anthropic/claude-haiku-4-5"),
  isProd: opt("NODE_ENV") === "production",
};
export type Env = typeof env;
