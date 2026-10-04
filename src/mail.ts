import { env } from "./env";
import { sleep, textToHtml } from "./util";

/** Thin AgentMail client. Plain fetch against the documented REST API keeps the surface small and the errors readable. */
const BASE = "https://api.agentmail.to/v0";

export class MailError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}

async function am<T>(path: string, init: RequestInit = {}, retries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE + path, {
      ...init,
      headers: { authorization: `Bearer ${env.agentmailKey}`, "content-type": "application/json", ...(init.headers as any) },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 429 && attempt < retries) {
      await sleep(Math.min(8000, (Number(res.headers.get("retry-after")) || 1) * 1000 * 2 ** attempt));
      continue;
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    if (!res.ok) throw new MailError(json?.message || `AgentMail HTTP ${res.status}`, res.status, json?.code);
    return json as T;
  }
}

export interface Sent {
  message_id: string;
  thread_id: string;
}

export interface SendArgs {
  inbox: string;
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  replyTo?: string;
  labels?: string[];
}

export function sendEmail(a: SendArgs): Promise<Sent> {
  return am<Sent>(`/inboxes/${encodeURIComponent(a.inbox)}/messages/send`, {
    method: "POST",
    body: JSON.stringify({
      to: a.to,
      ...(a.cc?.length ? { cc: a.cc } : {}),
      subject: a.subject,
      text: a.text,
      html: textToHtml(a.text),
      ...(a.replyTo ? { reply_to: a.replyTo } : {}),
      ...(a.labels?.length ? { labels: a.labels } : {}),
    }),
  });
}

export function replyEmail(a: { inbox: string; messageId: string; text: string; to?: string[]; cc?: string[]; labels?: string[] }): Promise<Sent> {
  return am<Sent>(`/inboxes/${encodeURIComponent(a.inbox)}/messages/${encodeURIComponent(a.messageId)}/reply`, {
    method: "POST",
    body: JSON.stringify({
      text: a.text,
      html: textToHtml(a.text),
      ...(a.to?.length ? { to: a.to } : {}),
      ...(a.cc?.length ? { cc: a.cc } : {}),
      ...(a.labels?.length ? { labels: a.labels } : {}),
    }),
  });
}

export interface MailMessage {
  inbox_id: string;
  thread_id: string;
  message_id: string;
  from: string;
  to: string[];
  cc?: string[];
  subject?: string;
  text?: string;
  extracted_text?: string;
  labels?: string[];
  timestamp: string;
  in_reply_to?: string;
}

export const getMessage = (inbox: string, messageId: string) =>
  am<MailMessage>(`/inboxes/${encodeURIComponent(inbox)}/messages/${encodeURIComponent(messageId)}`);

export async function listRecentMessages(inbox: string, limit = 15): Promise<Pick<MailMessage, "message_id" | "thread_id" | "from" | "labels" | "timestamp">[]> {
  const r = await am<{ messages: any[] }>(`/inboxes/${encodeURIComponent(inbox)}/messages?limit=${limit}`);
  return r.messages ?? [];
}

/** The text of a message as the author wrote it, without the quoted history. */
export const freshText = (m: Pick<MailMessage, "extracted_text" | "text">) => (m.extracted_text || m.text || "").trim();

/** Register (or reuse) the webhook for inbound mail. Returns the signing secret. */
export async function ensureWebhook(url: string): Promise<{ id: string; secret: string; created: boolean }> {
  const list = await am<{ webhooks: { webhook_id: string; url: string; secret?: string; enabled?: boolean }[] }>(`/webhooks`);
  const existing = list.webhooks?.find((w) => w.url === url);
  if (existing) {
    const full = await am<{ webhook_id: string; secret: string }>(`/webhooks/${encodeURIComponent(existing.webhook_id)}`);
    return { id: full.webhook_id, secret: full.secret, created: false };
  }
  const made = await am<{ webhook_id: string; secret: string }>(`/webhooks`, {
    method: "POST",
    body: JSON.stringify({ url, event_types: ["message.received", "message.bounced"], client_id: `badger-${new URL(url).host}` }),
  });
  return { id: made.webhook_id, secret: made.secret, created: true };
}
