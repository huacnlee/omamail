// UI labels, editable prompts and local composer/queue rules for AI jobs.
// Port of ui/agent/Agent.js. Job parsing, ownership, attention, history and
// payload construction live in Rust (`agent.jobsProjection`); this module
// only reads what Rust returned.

/** A job as `agent.jobsList` lists it. Fields the UI reads; Rust owns the rest. */
export interface AgentJob {
  id: string;
  conversationId?: string;
  accountId?: string;
  messageId?: string;
  messageIds?: string[];
  draftKey?: string;
  kind?: string;
  state?: string;
  question?: string;
  error?: string;
  summary?: string;
  subject?: string;
  progress?: string;
  stall?: string;
  resultReady?: boolean;
  canContinue?: boolean;
  created?: number;
  createdOrder?: number;
  requestPreview?: string;
  provider?: string;
  model?: string;
  events?: unknown;
  [key: string]: unknown;
}

export interface ChatEntry {
  role: "user" | "assistant" | "status";
  text: string;
}
export interface ChatRow {
  role: "user" | "assistant" | "status" | "proposal";
  text: string;
}

/** What a proposal envelope carries: routing is the app's, never the model's. */
export interface ProposalEnvelope {
  accountId: string;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
  subject?: string;
  body?: string;
  replyQuote?: string;
  attachments?: { filename?: string; name?: string; mimeType?: string; size?: number; data?: string; path?: string; owned?: boolean }[];
  draftId?: string;
  threadId?: string;
  inReplyTo?: string;
  replyMessageId?: string;
  [key: string]: unknown;
}
export interface Proposal {
  id: string;
  subject: string;
  body: string;
  applicable: boolean;
  afterTurn?: number;
  envelope?: ProposalEnvelope | null;
}

/** Editor identity and fields a draft chat is bound to. */
export interface DraftFields {
  accountId: string;
  draftKey: string;
  replyMessageId?: string;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  envelope?: ProposalEnvelope;
  [key: string]: unknown;
}

const ACTIVE = ["queued", "running"];

/** The input reads as the start of `/clear`. */
export function suggestsClear(text: string): boolean {
  const value = String(text || "");
  return !/[\r\n]/.test(value) && /^\s*\/[a-z]*$/.test(value) && "/clear".indexOf(value.trim()) === 0;
}

// Only detach the exact app-owned suffix, never text that merely looks quoted.
export function replyOnly(body: unknown, quote: unknown): string {
  const b = String(body || "");
  const q = String(quote || "");
  if (q === "") return b;
  if (b === q) return "";
  const suffix = "\n\n" + q;
  return b.slice(-suffix.length) === suffix ? b.slice(0, -suffix.length) : b;
}

export function proposalEnvelope(envelope: ProposalEnvelope): ProposalEnvelope {
  const result: ProposalEnvelope = JSON.parse(JSON.stringify(envelope));
  const quote = String(result.replyQuote || "");
  if (quote !== "") result.body = replyOnly(result.body, quote) + "\n\n" + quote;
  return result;
}

// A proposal is a separate local draft, including when another draft is open.
// Keep attachment bytes in its recovery record rather than sharing ownership
// of a temporary file that the current editor may remove.
export function proposalDraft(envelope: ProposalEnvelope, parentId: string, draftKey: string) {
  const attachments = JSON.parse(JSON.stringify(envelope.attachments || []));
  for (const item of attachments) {
    item.owned = false;
    if (item.data) item.path = "";
  }
  return {
    draftKey, agentParentJobId: String(parentId || ""),
    replyMessageId: String(envelope.replyMessageId || ""),
    accountId: String(envelope.accountId), fromEmail: String(envelope.from || ""),
    fromWasChosen: true, to: String(envelope.to || ""), cc: String(envelope.cc || ""),
    bcc: String(envelope.bcc || ""), replyTo: String(envelope.replyTo || ""),
    ccVisible: !!envelope.cc, bccVisible: !!envelope.bcc, replyToVisible: !!envelope.replyTo,
    subject: String(envelope.subject || ""), body: String(envelope.body || ""),
    bodyQuote: typeof envelope.replyQuote === "string" ? envelope.replyQuote : "",
    bodyWasEdited: true, userModified: true, placedBody: "",
    mode: envelope.replyMessageId ? "reply" : "new",
    sourceDraftId: String(envelope.draftId || ""), threadId: String(envelope.threadId || ""),
    inReplyTo: String(envelope.inReplyTo || ""), draftAttachments: attachments,
    originalAttachments: [], forwardedAttachments: [], replyRecipients: [],
  };
}

export function canUseDraftChat(job: AgentJob | null | undefined, fields: Partial<DraftFields>): boolean {
  return !!job && String(job.accountId || "") === String(fields.accountId || "")
    && (String(job.draftKey || "") === String(fields.draftKey || "")
      || (String(job.draftKey || "") === "" && !!fields.replyMessageId
        && String(job.messageId || "") === String(fields.replyMessageId)));
}

export function conversationWithProposals(conversation: ChatRow[], proposals: Pick<Proposal, "id" | "afterTurn">[]): ChatRow[] {
  const rows: ChatRow[] = [];
  for (let i = 0; i <= conversation.length; i++) {
    for (const proposal of proposals) {
      let at = typeof proposal.afterTurn === "number" ? proposal.afterTurn : conversation.length;
      at = Math.max(0, Math.min(conversation.length, at));
      // Tool execution can precede the answer's closing explanation. Keep the
      // draft below that complete reply, before the next user question.
      while (at < conversation.length && conversation[at].role !== "user") at++;
      if (at === i) rows.push({ role: "proposal", text: String(proposal.id) });
    }
    if (i < conversation.length) rows.push(conversation[i]);
  }
  return rows;
}

export function attachmentLabels(attachments: ProposalEnvelope["attachments"]): string {
  return (attachments || [])
    .map((item) => {
      const details: string[] = [];
      if (item.mimeType) details.push(String(item.mimeType));
      if (typeof item.size === "number") details.push(item.size + " bytes");
      return String(item.filename || item.name || "Attachment") + (details.length ? " (" + details.join(", ") + ")" : "");
    })
    .join("\n");
}

// Historical command answers still need their original body-only insertion rule.
export const MAIL_TRANSFORM_FORMAT =
  "Use exactly this reply layout: Title: <mail title>, then a blank line, then Body: on its own line followed by the mail body. Do not include any other headers or commentary.";

export function isActive(job: AgentJob | null | undefined): boolean {
  return !!job && ACTIVE.includes(String(job.state || ""));
}

export type Glyph = "" | "running" | "question" | "done" | "failed" | "cancelled";
export function glyphState(job: AgentJob | null | undefined): Glyph {
  if (!job) return "";
  const state = String(job.state || "");
  if (state === "queued" || state === "running") return "running";
  if (state === "done") return String(job.question || "") !== "" ? "question" : "done";
  if (state === "failed") return "failed";
  if (state === "cancelled") return "cancelled";
  return "";
}

/** The working line in pieces, for a view that draws the time in mono and
 * the interrupt key as a key cap: "Working", "41m 20s", interruptible. */
export function workingParts(job: AgentJob | null | undefined, now: number, preparationStarted: number) {
  const active = isActive(job);
  const start = active && Number(job!.created) > 0 ? Number(job!.created) * 1000 : preparationStarted;
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  return {
    label: active ? "Working" : "Preparing",
    duration: Math.floor(seconds / 60) + "m " + (seconds % 60) + "s",
    interruptible: active,
  };
}

export function workingText(job: AgentJob | null | undefined, now: number, preparationStarted: number): string {
  const parts = workingParts(job, now, preparationStarted);
  return "• " + parts.label + " (" + parts.duration + (parts.interruptible ? " • Esc to interrupt" : "") + ")";
}

/** A history row's pieces: when it started (local time) and what it asked. */
export function historyParts(job: AgentJob): { time: string; title: string } {
  return {
    time: new Date(Number(job.created || 0) * 1000).toLocaleString(),
    title: String(job.requestPreview || job.subject || "Conversation"),
  };
}

export function progressText(job: AgentJob | null | undefined): string {
  if (!job || !isActive(job)) return "";
  return String(job.progress || "").trim();
}

export function stateLabel(job: AgentJob | null | undefined): string {
  const glyph = glyphState(job);
  if (job && job.resultReady) return "Ready";
  if (glyph === "running") return String(job!.stall || "") === "permission" ? "Stopped to ask" : "Working";
  if (glyph === "question") return "Has a question";
  if (glyph === "done") return "Done";
  if (glyph === "failed") return "Failed";
  if (glyph === "cancelled") return "Cancelled";
  return "";
}

export function detailText(job: AgentJob | null | undefined): string {
  if (!job) return "";
  if (String(job.question || "") !== "") return String(job.question);
  if (String(job.error || "") !== "") return String(job.error);
  return String(job.summary || "");
}

export function isEventsJob(job: AgentJob | null | undefined): boolean {
  return !!job && String(job.kind || "") === "events";
}

/** The status-line note when a job finishes; "" when there is nothing to say. */
export function finishedNote(job: AgentJob | null | undefined): string {
  const glyph = glyphState(job);
  const subject = String(job && job.subject ? job.subject : "").trim();
  const about = subject === "" ? "the message" : "“" + subject + "”";
  // A look for events was not asked for by name: it says something only
  // when it found something, and nothing at all when it found nothing.
  if (isEventsJob(job)) {
    const events = job!.events;
    const found = glyph === "done" && Array.isArray(events) ? events.length : 0;
    return found > 0 ? "The agent found " + (found === 1 ? "an event" : found + " events") + " in " + about : "";
  }
  if (glyph === "question") return "The agent has a question about " + about;
  if (glyph === "done") return "The agent finished with " + about;
  if (glyph === "failed") return "The agent failed on " + about;
  if (glyph === "cancelled") return "The AI session for " + about + " was closed";
  return "";
}

export function pluralizeMessages(count: unknown): string {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  return n === 1 ? "1 message" : n + " messages";
}

export function draftAnswer(job: AgentJob | null | undefined, output: unknown, transcript?: ChatRow[]): string {
  if (!job || (isActive(job) && !job.resultReady) || glyphState(job) === "failed" || job.question) return "";
  const text = String(output || "");
  const rows = Array.isArray(transcript) ? transcript : [];
  for (const row of rows) {
    if (row.role === "user" && row.text.indexOf(MAIL_TRANSFORM_FORMAT) >= 0) {
      const body = /^Title: [^\r\n]*\r?\n\r?\nBody:\r?\n([\s\S]*)$/.exec(text);
      return body ? body[1] : "";
    }
  }
  return text;
}

// Editor change indicator only; ownership remains accountId plus draftKey.
export function draftFingerprint(fields: Partial<DraftFields> | null | undefined): string {
  const v = fields || {};
  const text = JSON.stringify([v.from || "", v.to || "", v.subject || "", v.body || ""]);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return String(hash);
}

export function chatEntries(value: unknown): ChatEntry[] {
  const rows = Array.isArray(value) ? value : [];
  const out: ChatEntry[] = [];
  for (const entry of rows) {
    if (!entry || !["user", "assistant", "status"].includes(entry.role) || typeof entry.text !== "string") continue;
    out.push({ role: entry.role, text: entry.text });
  }
  return out;
}

export function createdOrder(job: AgentJob | null | undefined): number {
  return Number((job && job.createdOrder) || Number((job && job.created) || 0) * 1000000000);
}

export function historyLabel(job: AgentJob): string {
  const parts = historyParts(job);
  return parts.time + " · " + parts.title;
}

/** The job a queued follow-up waits on: its conversation's newest. */
export function pendingJob(jobs: AgentJob[] | null | undefined, currentJob: AgentJob | null, scopeMatches: boolean, conversationId: string, previousId: string): AgentJob | null {
  let rows = Array.isArray(jobs) ? jobs : [];
  if (!rows.length && scopeMatches && currentJob) rows = [currentJob];
  let result: AgentJob | null = null;
  for (const job of rows) {
    if (conversationId === "") {
      if (!scopeMatches || !currentJob || job.id !== currentJob.id || String(job.id) === previousId) continue;
    } else if (String(job.conversationId || job.id) !== conversationId) continue;
    if (!result || createdOrder(job) > createdOrder(result)) result = job;
  }
  return result;
}

export function pendingLimit(messages: string[], text: string): string {
  if (messages.length >= 20) return "The queue is full. Wait for a reply or remove a pending message.";
  let size = text.length;
  for (const message of messages) size += message.length;
  if (text.length > 65536 || size > 262144) return "This pending message is too long. Shorten it before sending.";
  return "";
}

/** The slash commands the input offers, local to the dock. */
export const COMMANDS = ["/clear", "/history", "/diagnose"] as const;
export const COMMAND_LABELS: Record<string, string> = { "/clear": "New chat", "/history": "History...", "/diagnose": "Diagnose..." };
export function commandMatches(input: string): string[] {
  const value = input.trim();
  return COMMANDS.filter((command) => value.charAt(0) === "/" && command.indexOf(value) === 0);
}
