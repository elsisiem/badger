import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { AssistantRuntimeProvider, AuiIf, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useAuiState } from "@assistant-ui/react";
import { AssistantChatTransport, useChatRuntime } from "@assistant-ui/react-ai-sdk";

/**
 * Badger's chat intake, built on assistant-ui primitives and streamed from a Mastra agent.
 * Styled by /app.css (.bc-*). When the agent calls `open_case`, the tool call renders as a case card.
 */

let onOpened: (caseId: string) => void = () => {};

const Face = ({ mood, size = 28 }: { mood: string; size?: number }) => (
  <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
    <use href={`#bf-${mood}`} />
  </svg>
);

function CaseCard(props: any) {
  const r = props.result as { ok?: boolean; case_id?: string; title?: string; error?: string } | undefined;
  useEffect(() => {
    if (r?.ok && r.case_id) onOpened(r.case_id); // jump to the case page as soon as it exists
  }, [r?.ok, r?.case_id]);
  if (props.status?.type === "running" || !r) return <div className="bc-card bc-card-wait"><Face mood="sniffing" size={30} /> Opening the case...</div>;
  if (!r.ok) return <div className="bc-card bc-card-err">Could not open it: {r.error}</div>;
  return (
    <div className="bc-card">
      <div className="bc-card-t"><Face mood="victory" size={30} /> Case opened</div>
      <div className="bc-card-b">{r.title}</div>
      <a className="btn sm" href={`#/case/${r.case_id}`} onClick={() => r.case_id && onOpened(r.case_id)}>
        Watch Badger work →
      </a>
    </div>
  );
}

const Text = ({ text }: { text: string }) => <p className="bc-text">{text}</p>;

function Message() {
  const role = useAuiState((s: any) => s.message.role);
  return (
    <MessagePrimitive.Root className={`bc-msg ${role === "user" ? "bc-user" : "bc-bot"}`}>
      {role !== "user" && (
        <span className="bc-avatar">
          <Face mood="neutral" size={34} />
        </span>
      )}
      <div className="bc-bubble">
        <MessagePrimitive.Parts components={{ Text, tools: { by_name: { open_case: CaseCard }, Fallback: () => <div className="bc-tool">Looking something up...</div> } } as any} />
      </div>
    </MessagePrimitive.Root>
  );
}

const STARTERS = [
  "My roommate Alex (alex-roommate@agentmail.to) owes me $64.50 for the electric bill and Costco",
  "Sunnyside Fitness (sunnyside-gym@agentmail.to) kept charging me after I cancelled on Aug 12",
  "A company still hasn't refunded me and I don't have their email",
];

function Chat() {
  const runtime = useChatRuntime({ transport: new AssistantChatTransport({ api: "/api/chat" }) });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="bc-thread">
        <ThreadPrimitive.Viewport className="bc-viewport">
          <AuiIf condition={(s: any) => s.thread.isEmpty}>
            <div className="bc-welcome">
              <div className="bc-hi">Who's ignoring you?</div>
              <p>Tell me in your own words. I'll ask only what I need, then open the case. Nothing is sent until you approve it.</p>
              <div className="bc-starters">
                {STARTERS.map((t) => (
                  <ThreadPrimitive.Suggestion key={t} prompt={t} send className="bc-chip">
                    {t}
                  </ThreadPrimitive.Suggestion>
                ))}
              </div>
            </div>
          </AuiIf>
          <ThreadPrimitive.Messages>{() => <Message />}</ThreadPrimitive.Messages>
        </ThreadPrimitive.Viewport>
        <ComposerPrimitive.Root className="bc-composer">
          <ComposerPrimitive.Input className="bc-input" placeholder="e.g. my landlord ignores my repair request…" rows={1} autoFocus />
          <ComposerPrimitive.Send className="btn sm">Send</ComposerPrimitive.Send>
        </ComposerPrimitive.Root>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

(window as any).BadgerChat = {
  mount(el: HTMLElement, opts: { onOpened?: (id: string) => void } = {}) {
    onOpened = opts.onOpened ?? (() => {});
    createRoot(el).render(<Chat />);
  },
};
