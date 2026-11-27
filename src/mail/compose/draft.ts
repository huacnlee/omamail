// The compose draft as data: what ComposeView.qml kept in its fields, as one
// plain object that recovery stores, parking holds and the editor renders.
// Port of ComposeView.qml's snapshot/restore/fieldsForDraft/hasMeaningfulDraft
// and Agent.js replyOnly, plus the Message.js size/count words.

export type ComposeMode = "new" | "reply" | "replyAll" | "forward" | "draft";

/** One file the message carries. `data` is base64; `path` an absolute file the backend reads. */
export interface Attachment {
  filename: string;
  mimeType: string;
  size: number;
  data?: string;
  path?: string;
  /** A temporary file this app made (a paste): removing it forgets the file. */
  owned?: boolean;
  /** A provider part, for a forward or a saved draft. */
  attachmentId?: string;
  partId?: string;
}

export interface ReplyPerson {
  email: string;
  display?: string;
}

/** Everything a draft is, in the shape `compose.recoverySave` stores. */
export interface ComposeDraft {
  draftKey: string;
  replyMessageId: string;
  agentParentJobId: string;
  to: string;
  cc: string;
  bcc: string;
  replyTo: string;
  subject: string;
  body: string;
  /** The quoted original under a reply, kept so it can be taken out and put back. */
  bodyQuote: string;
  /** The body as placed (sign-off and quote): an untouched one is no edit. */
  placedBody: string;
  bodyWasEdited: boolean;
  userModified: boolean;
  accountId: string;
  sourceDraftId: string;
  mode: ComposeMode;
  threadId: string;
  inReplyTo: string;
  ccVisible: boolean;
  bccVisible: boolean;
  replyToVisible: boolean;
  fromEmail: string;
  replyRecipients: ReplyPerson[];
  fromWasChosen: boolean;
  originalAttachments: Attachment[];
  forwardedAttachments: Attachment[];
  draftAttachments: Attachment[];
  /** Recovery only: the send this draft is parked for. */
  pendingSendId?: string;
  /** Recovery only: the send it was parked for may or may not have gone. */
  deliveryUnknown?: boolean;
}

export const MODES: readonly ComposeMode[] = ["new", "reply", "replyAll", "forward", "draft"];

export const TITLES: Record<ComposeMode, string> = {
  new: "New message",
  reply: "Reply",
  replyAll: "Reply all",
  forward: "Forward",
  draft: "Draft",
};

export function newDraftKey(): string {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
}

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value.slice() as T[]) : [];
}

export function emptyDraft(key: string = newDraftKey()): ComposeDraft {
  return {
    draftKey: key,
    replyMessageId: "",
    agentParentJobId: "",
    to: "",
    cc: "",
    bcc: "",
    replyTo: "",
    subject: "",
    body: "",
    bodyQuote: "",
    placedBody: "",
    bodyWasEdited: false,
    userModified: false,
    accountId: "",
    sourceDraftId: "",
    mode: "new",
    threadId: "",
    inReplyTo: "",
    ccVisible: false,
    bccVisible: false,
    replyToVisible: false,
    fromEmail: "",
    replyRecipients: [],
    fromWasChosen: false,
    originalAttachments: [],
    forwardedAttachments: [],
    draftAttachments: [],
  };
}

/** A stored draft as the editor's state (ComposeView.restoreDraft). Untrusted input. */
export function restore(saved: unknown): ComposeDraft {
  const s = (saved && typeof saved === "object" ? saved : {}) as Record<string, unknown>;
  const mode = MODES.includes(s.mode as ComposeMode) ? (s.mode as ComposeMode) : "new";
  const draft: ComposeDraft = {
    draftKey: text(s.draftKey) || newDraftKey(),
    replyMessageId: text(s.replyMessageId),
    agentParentJobId: text(s.agentParentJobId),
    to: text(s.to),
    cc: text(s.cc),
    bcc: text(s.bcc),
    replyTo: text(s.replyTo),
    subject: text(s.subject),
    body: text(s.body),
    bodyQuote: typeof s.bodyQuote === "string" ? s.bodyQuote : "",
    placedBody: text(s.placedBody),
    bodyWasEdited: s.bodyWasEdited === true,
    userModified: false,
    accountId: text(s.accountId),
    sourceDraftId: text(s.sourceDraftId),
    mode,
    threadId: text(s.threadId),
    inReplyTo: text(s.inReplyTo),
    ccVisible: s.ccVisible === true,
    bccVisible: s.bccVisible === true,
    replyToVisible: s.replyToVisible === true || text(s.replyTo) !== "",
    fromEmail: text(s.fromEmail),
    replyRecipients: list<ReplyPerson>(s.replyRecipients),
    fromWasChosen: s.fromWasChosen === true,
    originalAttachments: list<Attachment>(s.originalAttachments),
    forwardedAttachments: list<Attachment>(s.forwardedAttachments),
    draftAttachments: list<Attachment>(s.draftAttachments),
  };
  if (s.deliveryUnknown === true) draft.deliveryUnknown = true;
  // Absence belongs to legacy records: derive it from what the draft holds.
  draft.userModified = typeof s.userModified === "boolean" ? s.userModified : meaningful(draft);
  return draft;
}

/** A plain copy, safe to store while the editor goes on changing its own. */
export function snapshot(draft: ComposeDraft): ComposeDraft {
  return JSON.parse(JSON.stringify(draft));
}

/** Files a send or save carries: forwarded originals (forwards only), then the draft's own. */
export function outgoingAttachments(draft: ComposeDraft): Attachment[] {
  const forwarded = draft.mode === "forward" ? draft.forwardedAttachments : [];
  return [...forwarded, ...draft.draftAttachments];
}

/** Whether leaving should ask (ComposeView.hasMeaningfulDraft). */
export function meaningful(draft: ComposeDraft): boolean {
  for (const value of [draft.to, draft.cc, draft.bcc, draft.subject]) {
    if (text(value).trim() !== "") return true;
  }
  if ((draft.bodyWasEdited || draft.body !== draft.placedBody) && draft.body.trim() !== "") return true;
  return outgoingAttachments(draft).length > 0;
}

/** The fields a provider draft save takes (ComposeView.fieldsForDraft). */
export interface DraftFields {
  accountId: string;
  draftId: string;
  from: string;
  to: string;
  cc: string;
  bcc: string;
  replyTo: string;
  subject: string;
  body: string;
  attachments: Attachment[];
  /** A forward starts a new conversation; a reply stays in the old one. */
  threadId: string;
  inReplyTo: string;
}

export function fieldsForDraft(draft: ComposeDraft): DraftFields {
  const forward = draft.mode === "forward";
  return {
    accountId: draft.accountId,
    draftId: draft.sourceDraftId,
    from: draft.fromEmail,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    replyTo: draft.replyTo,
    subject: draft.subject,
    body: draft.body,
    attachments: outgoingAttachments(draft),
    threadId: forward ? "" : draft.threadId,
    inReplyTo: forward ? "" : draft.inReplyTo,
  };
}

/** The reply text above the quoted history (Agent.js replyOnly). */
export function replyOnly(body: string, quote: string): string {
  const b = text(body);
  const q = text(quote);
  if (q === "") return b;
  if (b === q) return "";
  const suffix = "\n\n" + q;
  return b.slice(-suffix.length) === suffix ? b.slice(0, -suffix.length) : b;
}

export function isReply(mode: ComposeMode): boolean {
  return mode === "reply" || mode === "replyAll";
}

/** The body still ends with its quoted history. */
export function hasQuote(draft: ComposeDraft): boolean {
  return isReply(draft.mode) && draft.bodyQuote !== "" && replyOnly(draft.body, draft.bodyQuote) !== draft.body;
}

/** Takes the quoted history out of the body, or puts it back. */
export function toggleQuote(draft: ComposeDraft): string {
  if (!draft.bodyQuote || !isReply(draft.mode)) return draft.body;
  const reply = replyOnly(draft.body, draft.bodyQuote);
  return reply !== draft.body ? reply : draft.body + "\n\n" + draft.bodyQuote;
}

export function formatSize(bytes: unknown): string {
  const value = Math.max(0, Math.floor(Number(bytes) || 0));
  if (value < 1024) return value + " B";
  if (value < 1024 * 1024) return (value / 1024).toFixed(value < 10240 ? 1 : 0) + " KB";
  return (value / (1024 * 1024)).toFixed(value < 10485760 ? 1 : 0) + " MB";
}

export function formatCount(count: unknown, singular: string): string {
  const amount = Math.max(0, Math.floor(Number(count) || 0));
  return amount + " " + (singular || "item") + (amount === 1 ? "" : "s");
}

/** The largest file a message may carry (core attachment MAX_BYTES). */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const TOO_LARGE = "That file is larger than the 20 MB send limit";

// Unified ids: account + U+001F + provider id (Unified.js).
const ID_SEPARATOR = "\u001f";

export function accountOf(id: unknown): string {
  const value = text(id);
  const at = value.indexOf(ID_SEPARATOR);
  return at <= 0 ? "" : value.substring(0, at);
}

export function sourceIdOf(id: unknown): string {
  const value = text(id);
  const at = value.indexOf(ID_SEPARATOR);
  return at <= 0 ? value : value.substring(at + 1);
}

/** The mailbox a submission belongs to: the one it names, or the one its draft id was composed from. */
export function draftOwner(values: { accountId?: string; draftId?: string }): string {
  return text(values.accountId) || accountOf(values.draftId);
}

/** A `file://` URL as a local path; anything else is refused. */
export function pathFromUri(uri: string): string {
  const value = text(uri);
  if (!/^file:\/\//i.test(value)) return "";
  let path = value.substring(7);
  // file://localhost/path and file:///path both name a local file.
  if (path.startsWith("localhost/")) path = path.substring(9);
  try {
    path = decodeURIComponent(path);
  } catch {
    return "";
  }
  return path.startsWith("/") && !/[\u0000-\u001f]/.test(path) ? path : "";
}
