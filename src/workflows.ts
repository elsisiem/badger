import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { addEvent, getCase, patchCase } from "./store";
import { advance, deliverStep, isClosed, openApproval, prepareStep } from "./steps";

/**
 * One run of this workflow = one step of one case's plan.
 *
 *   prepare  -> draft the message and run the safety checks
 *   gate     -> if a human must approve, SUSPEND here. The run is snapshotted to Postgres, survives restarts,
 *               and resumes the moment the human taps approve / edit / skip (from the app or from an email link)
 *   deliver  -> send the email / fill the form / remind the human, then schedule the next wake-up
 *
 * Mastra gives us the durable "wait for a person" for free; the clock between steps lives in the cases table.
 */

const draftSchema = z.object({
  kind: z.enum(["email", "escalate_email", "web_form", "user_action", "final"]),
  level: z.number(),
  subject: z.string(),
  body: z.string(),
  to: z.string(),
  cc: z.array(z.string()),
  note: z.string().optional(),
  form_url: z.string().optional(),
});

const runInput = z.object({ caseId: z.string(), stepId: z.string() });
const decisionSchema = z.enum(["approve", "skip"]);

const prepare = createStep({
  id: "prepare",
  description: "Draft the message for this step and run the pre-flight safety checks",
  inputSchema: runInput,
  outputSchema: z.object({ caseId: z.string(), stepId: z.string(), draft: draftSchema.nullable(), needsApproval: z.boolean(), blocked: z.string().nullable() }),
  execute: async ({ inputData }) => {
    await patchCase(inputData.caseId, { status: "working", mood: "nagging", working_since: new Date().toISOString() });
    const p = await prepareStep(inputData.caseId, inputData.stepId);
    return { caseId: inputData.caseId, stepId: inputData.stepId, ...p };
  },
});

const gate = createStep({
  id: "gate",
  description: "Pause for the human's approval when the step needs it",
  inputSchema: prepare.outputSchema,
  outputSchema: z.object({ caseId: z.string(), stepId: z.string(), draft: draftSchema.nullable(), decision: decisionSchema, reason: z.string().nullable() }),
  resumeSchema: z.object({ decision: decisionSchema, subject: z.string().optional(), body: z.string().optional(), actionId: z.string().optional() }),
  suspendSchema: z.object({ actionId: z.string() }),
  execute: async ({ inputData, resumeData, suspend, runId }) => {
    const { caseId, stepId, draft, needsApproval, blocked } = inputData;
    if (blocked || !draft) return { caseId, stepId, draft: null, decision: "skip" as const, reason: blocked ?? "nothing to do" };
    const c = await getCase(caseId);
    if (!c || isClosed(c)) return { caseId, stepId, draft: null, decision: "skip" as const, reason: "the case was closed" };
    if (!needsApproval) return { caseId, stepId, draft, decision: "approve" as const, reason: null };

    if (!resumeData) {
      const actionId = await openApproval(caseId, stepId, draft, runId);
      return await suspend({ actionId });
    }
    // Resumed: apply any edits the human made, then continue.
    const edited = { ...draft, subject: resumeData.subject?.trim() || draft.subject, body: resumeData.body?.trim() || draft.body };
    return { caseId, stepId, draft: edited, decision: resumeData.decision, reason: null };
  },
});

const deliver = createStep({
  id: "deliver",
  description: "Send, submit or report, then schedule what comes next",
  inputSchema: gate.outputSchema,
  outputSchema: z.object({ outcome: z.string() }),
  execute: async ({ inputData }) => {
    const { caseId, stepId, draft, decision, reason } = inputData;
    if (!draft) {
      await addEvent(caseId, "skipped", "Step skipped", reason ?? undefined, { step_id: stepId });
      await advance(caseId, stepId, "skipped");
      return { outcome: `skipped: ${reason}` };
    }
    return deliverStep(caseId, stepId, draft, decision);
  },
});

export const nudgeStepWorkflow = createWorkflow({
  id: "nudge-step",
  inputSchema: runInput,
  outputSchema: z.object({ outcome: z.string() }),
})
  .then(prepare)
  .then(gate)
  .then(deliver)
  .commit();
