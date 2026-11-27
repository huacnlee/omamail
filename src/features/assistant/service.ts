// The asks: which account and messages an AI job is about, the context Rust
// reads for it, and the proposals it hands back. Port of the agent half of
// ui/Service.qml and of ui/agent/AgentContext.qml.
//
// Ownership rules, all from the Qt client and docs/SECURITY-BOUNDARIES.md:
// - A job belongs to one account: the one the owner asked from, never the
//   one open when the answer arrives. Unified ids carry their account.
// - Context comes from Rust (`agent.context`), resolved inside that account.
// - A reply's routing (sender, recipients, thread) is the app's: the host
//   builds the envelope; the model's proposal is a subject and a body only.
// - Sending is the owner's press, through the host's outbox, with the
//   proposal id as the idempotent send id.
import { Clipboard, appInfo, signal, type ClipboardWrite } from "nsh";
import { Backend, Diagnostics } from "omamail-native";
import { call, onError } from "../../backend/client";
import { splitUnifiedId } from "../../mail/unified";
import { canUseDraftChat, type AgentJob, type DraftFields, type ProposalEnvelope } from "../../mail/agent";
import { host } from "./host";
import { AgentRunner } from "./runner";
import { DiagnosticLog, diagnosticPrompt, diagnosticReport } from "./diagnostics";

/** Recent backend errors, reduced to known identifiers (diagnostics.ts). */
export const diagnosticLog = new DiagnosticLog();

/** Records one failed backend request for "Diagnose with AI...". The client
 * (or any caller) reports here; only allowlisted identifiers are kept. */
export function recordBackendError(method: string, error: unknown): void {
  diagnosticLog.record(method, error);
}

// Every failed backend request, from any feature.
onError((method, error) => recordBackendError(method, error));

export const runner = new AgentRunner((method, params) => call(method, params));

/** The ask's own error, beside the runner's: shown on the dock's status line. */
export const contextError = signal("");
export const contextBusy = signal(false);
let serial = 0;
let pending: { accountId: string; requestId: string; deadline: ReturnType<typeof setTimeout> } | null = null;

const PROPOSAL_ID = /^[a-f0-9]{32}-[0-9]+$/;

/** The backend answered `system.info`: whether this build runs AI jobs. */
export const agentCapable = signal<boolean | null>(null);

export function agentAvailable(): boolean {
  return agentCapable() === true && runner.available();
}

/** Reads `system.info` once and attaches the runner when AI jobs run here.
 * Once the answer is known (an earlier mount, a preview that set it) it does
 * not ask again. */
export async function startAgent(): Promise<void> {
  if (agentCapable() !== null) return;
  try {
    const info = await call<any>("system.info", {});
    const capable = !!(info && info.capabilities && info.capabilities.agent === true);
    agentCapable.set(capable);
    if (capable) runner.attach(Number(info.apiVersion) || 0);
  } catch {
    agentCapable.set(false);
  }
}

/** The account and its own id for a row id: a unified id names its account. */
export function agentTarget(messageId: string, accountId: string): { accountId: string; id: string } | null {
  const split = splitUnifiedId(String(messageId || ""));
  const owner = split.accountId !== "" ? split.accountId : String(accountId || "");
  const id = split.accountId !== "" ? split.id : String(messageId || "");
  if (owner === "" || id === "") return null;
  if (!host().hasAccount(owner)) {
    contextError.set("That mailbox is no longer set up, so AI was not asked.");
    return null;
  }
  return { accountId: owner, id };
}

function finishError(text: string) {
  serial++;
  contextBusy.set(false);
  contextError.set(text || "Could not prepare mail for AI");
  if (pending) {
    clearTimeout(pending.deadline);
    const { accountId, requestId } = pending;
    call("agent.contextCancel", { accountId, requestId }).catch(() => {});
  }
  pending = null;
}

/** Cancels a context read in flight (the dock closed, a new chat). */
export function cancelContext() {
  if (contextBusy()) finishError("Cancelled");
  contextError.set("");
}

interface ContextRequest {
  accountId: string;
  ids: string[];
  prompt: string;
  draftFields?: DraftFields | null;
  envelope?: ProposalEnvelope | null;
  continuation?: Record<string, unknown> | null;
}

/** Reads the mail through Rust, then starts the job. Port of AgentContext.request. */
export function requestContext(request: ContextRequest): boolean {
  if (contextBusy() || runner.starting()) {
    contextError.set("AI is still starting. Try again shortly.");
    return false;
  }
  contextError.set("");
  const { ids, prompt } = request;
  if (ids.length === 0 || ids.length > 20) {
    contextError.set("Select between 1 and 20 messages from one mailbox.");
    return false;
  }
  if (String(prompt || "").trim() === "") return false;
  if (!runner.available()) {
    contextError.set("Mail backend unavailable");
    return false;
  }
  const owner = request.accountId;
  const draftFields = request.draftFields ?? null;
  if (draftFields && String(draftFields.accountId || "") !== owner) {
    contextError.set("Draft belongs to another mailbox.");
    return false;
  }
  const modern = runner.apiVersion() >= 6;
  const envelope = modern ? request.envelope ?? null : null;
  const summaries = ids.map((id) => host().summary(owner, id) ?? { id: String(id) });
  const replyText = envelope ? host().bodyText(owner, ids[0]) : "";
  const token = ++serial;
  const selected = runner.selection();
  const requestId = "context-" + Date.now() + "-" + token;
  contextBusy.set(true);
  pending = { accountId: owner, requestId, deadline: setTimeout(() => {
    if (token === serial) finishError("Reading mail for AI timed out. Try again.");
  }, 60000) };

  const launch = (payload: any) => {
    if (token !== serial) return;
    if (!host().hasAccount(owner)) return finishError("That mailbox is no longer set up.");
    if (pending) clearTimeout(pending.deadline);
    pending = null;
    contextBusy.set(false);
    const object = request.continuation || payload.draftFields;
    if (!runner.start(object ? payload : JSON.stringify(payload), false, selected)) contextError.set(runner.lastError());
  };

  call<any>("agent.context", { accountId: owner, requestId, ids, summaries, folder: host().mailboxKey(owner), prompt: String(prompt) }).then(
    async (result) => {
      if (token !== serial) return;
      if (!host().hasAccount(owner)) return finishError("That mailbox is no longer set up.");
      if (!result || !result.payload) return finishError("Could not prepare mail for AI. Try again.");
      const payload = result.payload;
      if (String(payload.accountId || "") !== owner) return finishError("Mail context does not belong to this mailbox.");
      if (request.continuation) {
        const next: any = JSON.parse(JSON.stringify(request.continuation));
        if (modern) {
          next.mailUpdate = { accountId: owner, messageId: String(payload.messageId), message: String(payload.message) };
          if (payload.threadMessages) next.mailUpdate.threadMessages = payload.threadMessages;
          if (payload.threadContext) next.mailUpdate.threadContext = payload.threadContext;
        }
        return launch(next);
      }
      if (envelope) payload.envelope = JSON.parse(JSON.stringify(envelope));
      if (draftFields) {
        payload.draftKey = String(draftFields.draftKey);
        payload.draft = { from: String(draftFields.from || ""), to: String(draftFields.to || ""),
          subject: String(draftFields.subject || ""), body: String(draftFields.body || "") };
        if (modern) {
          payload.draft.cc = String(draftFields.cc || "");
          payload.draft.bcc = String(draftFields.bcc || "");
          if (draftFields.envelope) payload.envelope = draftFields.envelope;
        }
      }
      if (envelope && !draftFields) {
        try {
          const prepared = await call<any>("message.composeText", { summary: summaries[0], body: replyText, signature: String(envelope.body || "") });
          if (token !== serial) return;
          if (!prepared) return finishError("Could not prepare the reply text.");
          payload.envelope.replyQuote = String(prepared.quote || "");
          payload.envelope.subject = String(prepared.replySubject || "");
        } catch {
          if (token === serial) finishError("Could not prepare the reply text.");
          return;
        }
      }
      launch(payload);
    },
    (failure) => {
      if (token !== serial) return;
      const code = failure && failure.message ? String(failure.message) : "";
      // Missing or offline mail must not strand a recovered draft or an
      // open conversation; a size refusal never becomes a smaller request.
      if (code !== "agent_context_too_large" && (draftFields || request.continuation)) {
        return launch(request.continuation || { draftFields, ask: prompt, account: host().accountEmail(owner), accountId: owner });
      }
      finishError(code === "agent_context_too_large" ? "These messages are too large. Select fewer messages." : "Could not prepare mail for AI. Try again.");
    },
  );
  return true;
}

// ------------------------------------------------------------------ asks

/** A question about one message. */
export async function askAgent(messageId: string, prompt: string, accountId: string): Promise<boolean> {
  if (!agentAvailable()) return false;
  const target = agentTarget(messageId, accountId);
  if (!target) return false;
  let envelope: ProposalEnvelope | null = null;
  if (runner.apiVersion() >= 6) {
    envelope = await host().replyEnvelope(target.accountId, target.id);
    // The host must answer for the account and message asked about.
    if (envelope && (String(envelope.accountId) !== target.accountId || String(envelope.replyMessageId || "") !== target.id)) envelope = null;
  }
  return requestContext({ accountId: target.accountId, ids: [target.id], prompt, envelope });
}

/** One job over several messages, all from one mailbox. */
export function askAgentMany(ids: string[], prompt: string, accountId: string): boolean {
  if (!agentAvailable()) return false;
  let owner = "";
  const own: string[] = [];
  for (const id of ids) {
    const target = agentTarget(id, accountId);
    if (!target) return false;
    if (owner !== "" && target.accountId !== owner) {
      contextError.set("Select messages from one mailbox at a time.");
      return false;
    }
    owner = target.accountId;
    own.push(target.id);
  }
  if (owner === "") return false;
  return requestContext({ accountId: owner, ids: own, prompt });
}

/** The composer's ask: the draft as it stands and what to do with it. */
export function askAgentDraft(fields: DraftFields, ask: string): boolean {
  if (!agentAvailable()) return false;
  if (!fields || !fields.draftKey || !host().hasAccount(fields.accountId) || String(ask || "").trim() === "") return false;
  contextError.set("");
  if (fields.replyMessageId) return requestContext({ accountId: fields.accountId, ids: [String(fields.replyMessageId)], prompt: ask, draftFields: fields });
  return runner.start({ draftFields: fields, ask, account: host().accountEmail(fields.accountId), accountId: fields.accountId }, false);
}

/** A follow-up: a new job that continues `jobId`. */
export function answerAgent(jobId: string, answer: string, fields: DraftFields | null): boolean {
  if (!agentAvailable()) return false;
  const job: AgentJob | null = runner.jobById(jobId);
  const text = String(answer || "").trim();
  if (!job || !job.canContinue || !runner.canContinueSelection(job) || runner.isActive(job) || !host().hasAccount(String(job.accountId || "")) || text === "") return false;
  contextError.set("");
  const payload: any = { parent: String(job.id), prompt: text };
  if (fields && !canUseDraftChat(job, fields)) return false;
  if (fields && runner.apiVersion() >= 6) {
    const attaching = String(job.draftKey || "") === "" && String(fields.draftKey || "") !== "";
    payload.draftUpdate = { accountId: String(fields.accountId), draftKey: String(fields.draftKey),
      draft: { from: String(fields.from || ""), to: String(fields.to || ""), cc: String(fields.cc || ""),
        bcc: String(fields.bcc || ""), subject: String(fields.subject || ""), body: String(fields.body || "") } };
    if (attaching) payload.draftUpdate.messageId = String(fields.replyMessageId);
    if (fields.envelope) payload.draftUpdate.envelope = fields.envelope;
  }
  if (runner.apiVersion() >= 6 && job.messageId && (!Array.isArray(job.messageIds) || job.messageIds.length === 1)) {
    return requestContext({ accountId: String(job.accountId), ids: [String(job.messageId)], prompt: text, continuation: payload });
  }
  return runner.start(payload, false);
}

/** Sends a proposal as shown, after the owner pressed Send. The envelope's
 * routing is the app's (see `proposalEnvelope`); the outbox delivers it. */
export async function sendProposal(proposalId: string, envelope: ProposalEnvelope, jobId: string): Promise<boolean> {
  const id = String(proposalId || "");
  if (!PROPOSAL_ID.test(id) || !envelope || !host().hasAccount(String(envelope.accountId || ""))) return false;
  const job = runner.jobById(jobId);
  // The proposal must be this job's and the job the envelope's account's.
  if (!job || id.indexOf(String(job.id) + "-") !== 0 || String(job.accountId) !== String(envelope.accountId)) return false;
  if (host().composer.routingChanged(envelope, id)) return false;
  const outgoing = { ...envelope, exactBody: true };
  const result = await host().composer.sendProposal(outgoing, "agent-" + id, String(job.id));
  if (!result.ok) contextError.set(result.error || "Could not queue the email. Try again.");
  return result.ok;
}

/** Where "Diagnose with AI..." hands the report: the native helper and
 * the clipboard (a test passes stand-ins). */
export interface DiagnoseOutlets {
  openAgent(report: string): Promise<string>;
  copy(text: string): Promise<ClipboardWrite>;
}

const SYSTEM_OUTLETS: DiagnoseOutlets = {
  openAgent: (report) => Diagnostics.openAgent(report),
  copy: (text) => Clipboard.writeText(text),
};

/** "Diagnose with AI...": the privacy-reduced report and read-only
 * instructions for the owner's own agent. On Omarchy the report is saved
 * owner-only and opened in `omarchy-agent` (the native helper, fixed argv);
 * elsewhere, or when that fails for any reason, it goes on the clipboard for
 * the owner to paste, as Qt did. Nothing is sent anywhere by the app.
 * Resolves to the notice the status line shows. */
export async function diagnose(outlets: DiagnoseOutlets = SYSTEM_OUTLETS): Promise<string> {
  let os = "";
  try {
    os = Backend.os();
  } catch {
    os = "unknown";
  }
  const report = diagnosticReport(
    { appVersion: appInfo().version ?? "unknown", apiVersion: runner.apiVersion(), os },
    diagnosticLog.entries(),
  );
  try {
    if ((await outlets.openAgent(report)) === "opened") return "Opened the diagnosis in your AI agent.";
  } catch {
    // report_invalid, storage_unavailable, agent_failed: the clipboard.
  }
  const written = await outlets.copy(diagnosticPrompt(report)).catch(() => "failed" as const);
  return written === "failed"
    ? "Could not copy the diagnosis. Try again."
    : "Diagnosis copied. Paste it into your AI agent.";
}
