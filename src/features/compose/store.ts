// The compose feature's state: the open draft, drafts parked for their undo
// window, drafts waiting to reopen, attachments in flight, the contact book,
// the From rows, and durable recovery. Port of ComposeView.qml's model, the
// compose parts of App.qml and Service.qml, account/SendQueue.qml (through
// src/mail/compose/sendQueue.ts), compose/RecoveryController.qml and
// account/ContactBook.qml.
//
// Ownership rules carried over from the Qt client:
// - A draft names the mailbox it belongs to (`accountId`); it is saved and
//   sent through that mailbox only, never one matched by a shared alias.
// - A From that is not one of that mailbox's aliases is refused.
// - Sending goes through `message.compose` and the backend outbox
//   (`outbox.enqueue`); the window never delivers mail itself.
// - Nothing a sender or a model wrote picks recipients or sends: a send is
//   the user's press or key.
import { batch, computed, effect, signal, untracked } from "nsh";
import { Picker } from "nsh";
import { app } from "../../app/store";
import { registerCommand } from "../../keys/commands";
import { dismissToast, toast } from "../../ui";
import * as Draft from "../../mail/compose/draft";
import type { Attachment, ComposeDraft, ComposeMode } from "../../mail/compose/draft";
import { composeHost, loadRegistry, setAccountsSource, composeRpc, type PreparedMessage } from "../../mail/compose/host";
import * as Mailto from "../../mail/compose/mailto";
import { normalizeDelay } from "../../mail/compose/outbox";
import * as Recipients from "../../mail/compose/recipients";
import type { Contact } from "../../mail/compose/recipients";
import * as Recovery from "../../mail/compose/recovery";
import * as Senders from "../../mail/compose/senders";
import type { SendIdentity } from "../../mail/compose/senders";
import { SendQueue, type OutboxEntry } from "../../mail/compose/sendQueue";

// Every backend call goes through compose's seam, so a preview can run on synthetic data.
const call = <T = any>(method: string, params: object = {}): Promise<T> => composeRpc().call<T>(method, params);
const on = (method: string, listener: (params: any) => void): (() => void) => composeRpc().on(method, listener);

// ------------------------------------------------------------------ types

/** What the reader, the list and the shell ask compose to open. */
export interface ComposeRequest {
  /** The mailbox the draft belongs to; the active one when left out. */
  accountId?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  /** Answer or forward a message. */
  replyTo?: {
    accountId: string;
    messageId: string;
    mode: "reply" | "replyAll" | "forward";
    /** The message, when the caller already read it (the reader). */
    summary?: any;
    /** Its body text. */
    body?: string;
    /** Its parts, for a forward. */
    attachments?: any[];
  };
  /** Reopen a saved draft: its provider id, and what it holds. */
  draftId?: string;
  from?: string;
  threadId?: string;
  inReplyTo?: string;
  /** A saved draft's parts, read from the provider by `draftId`. */
  attachments?: any[];
  /** A `mailto:` URL, read as RFC 6068. Takes the fields it names. */
  mailto?: string;
}

/** A parked draft: the send it waits on, and the words to restore if it does not go. */
interface Parked {
  sendId: string;
  draft: ComposeDraft;
}

interface AttachJob {
  mode: "read" | "forget" | "recover" | "recover-owned";
  path: string;
}

// ------------------------------------------------------------------ state

const draftSignal = signal<ComposeDraft>(Draft.emptyDraft());
const openedSignal = signal(false);
const parkedSignal = signal<Parked[]>([]);
/** A draft the user had open when a parked one came back: it reopens next. */
const interruptedSignal = signal<ComposeDraft | null>(null);
/** Drafts waiting to reopen, in order (recovered, or displaced). */
const recoveryDraftsSignal = signal<ComposeDraft[]>([]);
const forwardLoadingSignal = signal(false);
const forwardErrorSignal = signal("");
const attachingSignal = signal(false);
const contactsSignal = signal<Contact[]>([]);
const identitiesSignal = signal<SendIdentity[]>([]);
const recoveryNoticeSignal = signal("");
const exitDialogSignal = signal(false);
const busySignal = signal(false);
/** Compose is shown in its own desktop window rather than over the mail. */
const windowedSignal = signal(false);
/** Bumps to ask the surface to place the keyboard (`takeFocus`). */
const focusRequestSignal = signal(0);

let composeTextSerial = 0;
let forwardLoadSerial = 0;
const sendSession = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
let sendSequence = 0;

// ---------------------------------------------------------------- reading

const queuesSignal = signal(new Map<string, SendQueue>());
export const compose = {
  draft: () => draftSignal(),
  opened: () => openedSignal(),
  parked: () => parkedSignal(),
  mode: computed<ComposeMode>(() => draftSignal().mode),
  title: computed(() => Draft.TITLES[draftSignal().mode]),
  forwardLoading: () => forwardLoadingSignal(),
  forwardError: () => forwardErrorSignal(),
  attaching: () => attachingSignal(),
  contacts: () => contactsSignal(),
  recoveryNotice: () => recoveryNoticeSignal(),
  exitDialogOpen: () => exitDialogSignal(),
  busy: () => busySignal(),
  windowed: () => windowedSignal(),
  focusRequest: () => focusRequestSignal(),
  /** Every file this draft carries, in send order. */
  attachments: computed(() => Draft.outgoingAttachments(draftSignal())),
  hasQuote: computed(() => Draft.hasQuote(draftSignal())),
  canToggleQuote: computed(() => Draft.isReply(draftSignal().mode) && draftSignal().bodyQuote !== ""),
  /** From rows this draft may use: any mailbox for a new message, its own for a reply or forward. */
  fromRows: computed<SendIdentity[]>(() => {
    const d = draftSignal();
    const rows = identitiesSignal();
    if (rows.length > 0) return Senders.visible(rows, d.accountId, d.mode);
    const host = composeHost();
    return host.aliasesFor(d.accountId).map((alias) => ({ accountId: d.accountId, email: alias.email, displayName: alias.displayName ?? "" }));
  }),
  /** Sending is held while forwarded originals are still loading or failed. */
  canSend: computed(() => openedSignal() && !forwardLoadingSignal() && forwardErrorSignal() === "" && !attachingSignal() && draftSignal().fromEmail !== ""),
  /** Why Send is held for want of a sender, or "" (the other holds show their own state). */
  sendBlockedReason: computed(() => {
    if (!openedSignal() || draftSignal().fromEmail !== "") return "";
    return app.accounts().length === 0 ? "Add a mailbox to send from" : "Choose a From address";
  }),
  /** Seconds until the newest parked send goes, and how many are parked. */
  sendSeconds: computed(() => {
    const queue = latestQueue();
    return queue ? queue.secondsRemaining() : 0;
  }),
  sendPendingCount: computed(() => {
    let count = 0;
    for (const queue of queuesSignal().values()) count += queue.parked().length;
    return count;
  }),
  suggestions(field: "to" | "cc" | "bcc", text: string): Contact[] {
    return Recipients.suggest(contactsSignal(), text, 5);
  },
};

// --------------------------------------------------------------- notices

function fail(message: string) {
  app.setNotice(message);
  toast({ title: message, kind: "error", id: "compose-error" });
}

function note(message: string) {
  app.setNotice(message);
}

// ---------------------------------------------------------------- editing

const committed = Recipients.committed;
const addressList = Recipients.addressList;

/** Forgets the files this window wrote for a draft (a pasted image saved to the backend's store). */
function owned(attachments: Attachment[] | undefined) {
  for (const file of attachments ?? []) {
    if (file && file.owned && file.path) enqueueAttach("forget", file.path);
  }
}

/** Changes fields of the open draft. `user`: the user did it (asks on leaving, saves recovery). */
export function update(patch: Partial<ComposeDraft>, user = true) {
  draftSignal.set({ ...draftSignal(), ...patch, ...(user ? { userModified: true } : {}) });
  if (user) scheduleRecovery();
}

export function setBody(body: string) {
  update({ body, bodyWasEdited: true });
}

export function toggleQuote() {
  const d = draftSignal();
  if (!Draft.isReply(d.mode) || !d.bodyQuote) return;
  update({ body: Draft.toggleQuote(d), bodyWasEdited: true });
}

export function showField(field: "cc" | "bcc" | "replyTo") {
  if (field === "cc") update({ ccVisible: true }, false);
  else if (field === "bcc") update({ bccVisible: true }, false);
  else update({ replyToVisible: true }, false);
}

export function acceptSuggestion(field: "to" | "cc" | "bcc", contact: Contact) {
  update({ [field]: Recipients.accept(draftSignal()[field], contact) } as Partial<ComposeDraft>);
}

/** A contact from the picker, at the end of a field (shows Cc or Bcc). */
export function addContact(field: "to" | "cc" | "bcc", contact: Contact) {
  const d = draftSignal();
  const patch: Partial<ComposeDraft> = { [field]: Recipients.append(d[field], contact) } as Partial<ComposeDraft>;
  if (field === "cc") patch.ccVisible = true;
  if (field === "bcc") patch.bccVisible = true;
  update(patch);
}

export function chooseFrom(identity: SendIdentity) {
  const accountId = String(identity.accountId || "") || draftSignal().accountId;
  const previous = draftSignal().accountId;
  // A saved draft's id names a copy in its own mailbox only: a draft moved to
  // another mailbox saves as a new copy there, so the save cannot remove that
  // mailbox's draft at the same id, and the first mailbox keeps its copy.
  const moved = accountId !== previous ? { sourceDraftId: "" } : {};
  update({ fromEmail: String(identity.email || ""), fromWasChosen: true, accountId, ...moved });
  // The sign-off follows the mailbox, but only while the body is the one placed.
  const d = draftSignal();
  if (accountId !== previous && d.mode !== "draft" && !d.bodyWasEdited && d.body === d.placedBody) placeBody(null, "");
}

/**
 * The draft's From when nobody chose one: the address the original reached
 * (a reply), else the mailbox's default or primary address, as Qt did. A
 * draft with no mailbox yet takes the active one. Runs whenever the mailboxes
 * or their send-as rows change, so a list that lands after the draft opened
 * still fills it; an address the user chose is never replaced.
 */
function ensureFrom() {
  const d = draftSignal();
  if (!openedSignal() || d.fromWasChosen) return;
  let accountId = d.accountId;
  if (accountId === "" && d.mode === "new") accountId = defaultAccount();
  if (accountId === "") return;
  const candidates = fromCandidates(accountId);
  const current = d.fromEmail.trim().toLowerCase();
  if (current !== "" && candidates.some((c) => c.email.toLowerCase() === current)) {
    if (accountId !== d.accountId) draftSignal.set({ ...d, accountId });
    return;
  }
  if (current !== "" && candidates.length === 0) return; // nothing to judge it against yet
  const choice = Senders.preferredSendAs(candidates, d.replyRecipients);
  const fromEmail = choice ? String(choice.email || "") : "";
  if (fromEmail !== d.fromEmail || accountId !== d.accountId) draftSignal.set({ ...d, accountId, fromEmail });
}

/** The addresses a mailbox may send as: its registry aliases, else its send-as rows. */
function fromCandidates(accountId: string): { email: string; isDefault?: boolean; isPrimary?: boolean }[] {
  const aliases = composeHost().aliasesFor(accountId).filter((a) => String(a.email || "").includes("@"));
  if (aliases.length > 0) return aliases;
  return identitiesSignal()
    .filter((row) => row.accountId === accountId && String(row.email || "").includes("@"))
    .map((row) => ({ email: row.email, isDefault: (row as any).isDefault === true, isPrimary: row.isPrimary === true }));
}

/** Rebuilds the sign-off and quote around what the user wrote first (`message.composeText`). */
function placeBody(summary: any, originalBody: string, prefix = "") {
  const serial = ++composeTextSerial;
  const d = draftSignal();
  const account = d.accountId;
  const previous = d.body;
  const previouslyEdited = d.bodyWasEdited;
  const previousSubject = d.subject;
  const params: Record<string, unknown> = { signature: composeHost().signatureFor(account).text, quote: d.bodyQuote };
  if (summary) {
    params.summary = summary;
    params.body = originalBody;
  }
  call<{ body?: string; quote?: string; replySubject?: string }>("message.composeText", params).then(
    (result) => {
      const now = draftSignal();
      if (serial !== composeTextSerial || account !== now.accountId || !openedSignal()) return;
      if (now.body !== previous || now.bodyWasEdited !== previouslyEdited) return;
      const placed = prefix + String(result?.body || "");
      const patch: Partial<ComposeDraft> = { bodyQuote: String(result?.quote || ""), placedBody: placed, body: placed };
      if (summary && Draft.isReply(now.mode) && now.subject === previousSubject) {
        patch.subject = String(result?.replySubject || previousSubject);
      }
      draftSignal.set({ ...now, ...patch });
      focusRequestSignal.update((n) => n + 1);
    },
    () => {
      if (serial === composeTextSerial) fail("Could not prepare the message text");
    },
  );
}

// --------------------------------------------------------------- opening

function defaultAccount(): string {
  const id = app.accountId();
  if (id) return id;
  const accounts = app.accounts();
  return accounts.length > 0 ? accounts[0].id : "";
}

/** The draft owner's own addresses: only these count as "me" in reply addressing. */
function ownReplyAddresses(accountId: string) {
  const host = composeHost();
  const own: { email: string }[] = [{ email: host.ownAddressFor(accountId) }];
  for (const alias of host.aliasesFor(accountId)) own.push({ email: alias.email });
  for (const row of identitiesSignal()) if (row.accountId === accountId) own.push({ email: row.email });
  return own;
}

/** Puts a draft that was open aside so a new one does not throw it away. */
function setAsideOpen() {
  if (!openedSignal()) return;
  const d = draftSignal();
  if (d.userModified && Draft.meaningful(d)) recoveryDraftsSignal.set([...recoveryDraftsSignal(), Draft.snapshot(d)]);
  else owned(d.draftAttachments);
}

function clearCurrent(forgetAttachments: boolean) {
  const d = draftSignal();
  composeTextSerial++;
  forwardLoadSerial++;
  batch(() => {
    draftSignal.set(Draft.emptyDraft());
    forwardLoadingSignal.set(false);
    forwardErrorSignal.set("");
    attachJobs.length = 0;
    attachingSignal.set(false);
  });
  if (forgetAttachments) owned(d.draftAttachments);
}

function show() {
  openedSignal.set(true);
  if (!windowedSignal() && !app.composing()) app.openOverlay("compose");
  focusRequestSignal.update((n) => n + 1);
}

/**
 * Opens compose: a new message, a reply or forward, a saved draft, or a
 * `mailto:` link. A draft already open with changes is kept and reopens when
 * this one closes.
 */
export function openCompose(request: ComposeRequest = {}) {
  const input = request ?? {};
  // An outside link that does not parse opens nothing and disturbs nothing.
  const fromLink = input.mailto ? Mailto.parse(input.mailto) : null;
  if (input.mailto && !fromLink) return;
  void loadRegistry();
  refreshContacts();
  refreshIdentities();
  setAsideOpen();
  clearCurrent(false);
  const reply = input.replyTo;
  const mode: ComposeMode = reply ? reply.mode : input.draftId ? "draft" : "new";
  const accountId = String(input.accountId || reply?.accountId || Draft.accountOf(input.draftId) || defaultAccount());
  const fields = {
    to: committed(Mailto.headerSafe(fromLink?.to ?? input.to ?? "")),
    cc: committed(Mailto.headerSafe(fromLink?.cc ?? input.cc ?? "")),
    bcc: committed(Mailto.headerSafe(fromLink?.bcc ?? input.bcc ?? "")),
    subject: Mailto.headerSafe(fromLink?.subject ?? input.subject ?? ""),
    body: String(fromLink?.body ?? input.body ?? ""),
  };
  const base: ComposeDraft = {
    ...Draft.emptyDraft(),
    mode,
    accountId,
    replyMessageId: reply && reply.mode !== "forward" ? String(reply.messageId) : "",
  };
  draftSignal.set(base);
  show();
  if (reply) {
    beginReply(reply, accountId);
    return;
  }
  const draftId = Draft.sourceIdOf(input.draftId ?? "");
  // Opened by its id alone, a saved draft is read from its mailbox first.
  const reopening = mode === "draft" && input.to === undefined && input.subject === undefined && input.body === undefined;
  const d: ComposeDraft = {
    ...base,
    ...fields,
    ccVisible: fields.cc.trim() !== "",
    bccVisible: fields.bcc.trim() !== "",
    sourceDraftId: reopening ? "" : draftId,
    threadId: String(input.threadId || ""),
    inReplyTo: String(input.inReplyTo || ""),
  };
  if (mode === "draft") {
    // Somebody wrote this and it was saved: all of it is theirs, sign-off included.
    d.placedBody = "";
    d.bodyWasEdited = true;
  }
  const from = String(input.from || "").trim();
  if (from !== "") {
    d.fromEmail = from;
    d.fromWasChosen = true;
  }
  draftSignal.set(d);
  ensureFrom();
  if (mode !== "draft") placeBody(null, "", fields.body);
  else if (reopening) void reopenSavedDraft(accountId, draftId);
  else loadDraftAttachments(accountId, draftId, input.attachments ?? []);
}

/**
 * A draft reopened by its id alone (the list's Continue editing, the reader's
 * edit key) is read from its mailbox, as a reply reads its original. What the
 * user typed while it was read stays.
 *
 * Saving or sending replaces the copy a draft is linked to, so it is linked
 * only once it holds all of that copy: its text read untouched, then its files.
 * Until then (a recovery record included), or when the user typed while it was
 * read, a save makes a new draft and the saved one keeps what it had.
 */
async function reopenSavedDraft(accountId: string, messageId: string) {
  const key = draftSignal().draftKey;
  const host = composeHost();
  if (!host.readMessage) {
    fail("That draft could not be read");
    return;
  }
  busySignal.set(true);
  let saved: PreparedMessage;
  try {
    saved = await host.readMessage(accountId, messageId);
  } catch (error) {
    if (draftSignal().draftKey === key) fail(String((error as Error)?.message || "That draft could not be read"));
    return;
  } finally {
    busySignal.set(false);
  }
  if (draftSignal().draftKey !== key || !openedSignal()) return;
  const summary = saved.summary ?? {};
  const recipients = (values: unknown) =>
    committed(Recipients.normalize(Array.isArray(values) ? values : [values]).map(Recipients.address).join(", "));
  const keep = (current: string, value: string) => (current.trim() === "" ? value : current);
  // The backend names an empty subject for the list; a draft's field stays empty.
  const subject = String(summary.subject || "");
  const d = { ...draftSignal() };
  d.to = keep(d.to, recipients(summary.to));
  d.cc = keep(d.cc, recipients(summary.cc));
  d.bcc = keep(d.bcc, recipients(summary.bcc));
  d.replyTo = keep(d.replyTo, recipients(summary.replyTo));
  d.subject = keep(d.subject, subject === "(no subject)" ? "" : subject);
  d.body = keep(d.body, saved.body);
  d.ccVisible = d.ccVisible || d.cc !== "";
  d.bccVisible = d.bccVisible || d.bcc !== "";
  d.replyToVisible = d.replyToVisible || d.replyTo !== "";
  d.threadId = d.threadId || String(summary.threadId || "");
  d.inReplyTo = d.inReplyTo || String(summary.inReplyTo || "");
  // Its From comes back only where this mailbox may still send as it; otherwise
  // the mailbox's own choice stands rather than a From that refuses to save.
  const from = Recipients.cleanContact(summary.from)?.email.toLowerCase() ?? "";
  if (!d.fromWasChosen && from !== "" && fromCandidates(accountId).some((c) => c.email.toLowerCase() === from)) d.fromEmail = from;
  draftSignal.set(d);
  ensureFrom();
  loadDraftAttachments(accountId, messageId, saved.attachments, !d.userModified);
}

async function beginReply(reply: NonNullable<ComposeRequest["replyTo"]>, accountId: string) {
  const key = draftSignal().draftKey;
  let summary = reply.summary;
  let body = String(reply.body ?? "");
  let attachments = Array.isArray(reply.attachments) ? reply.attachments : [];
  if (!summary) {
    const host = composeHost();
    if (!host.readMessage) {
      fail("That message could not be read");
      return;
    }
    busySignal.set(true);
    try {
      const read = await host.readMessage(accountId, Draft.sourceIdOf(reply.messageId));
      summary = read.summary;
      body = read.body;
      attachments = read.attachments;
    } catch (error) {
      if (draftSignal().draftKey === key) fail(String((error as Error)?.message || "That message could not be read"));
      return;
    } finally {
      busySignal.set(false);
    }
    if (draftSignal().draftKey !== key || !openedSignal()) return;
  }
  const d = { ...draftSignal() };
  d.threadId = String(summary?.threadId || "");
  d.inReplyTo = String(summary?.messageId || "");
  if (Draft.isReply(d.mode)) {
    // Cc as well as To: an alias is just as often the address a thread copied
    // you on as the one it was sent to.
    d.replyRecipients = [...(summary?.to ?? []), ...(summary?.cc ?? [])];
  }
  if (d.mode === "forward") {
    d.subject = "Fwd: " + String(summary?.subject || "");
    d.originalAttachments = attachments.slice();
  } else {
    const fields = Recipients.replyFields(summary, d.mode, ownReplyAddresses(accountId));
    d.to = committed(fields.to);
    d.cc = committed(fields.cc);
    d.ccVisible = fields.cc !== "";
    if (fields.outgoing && summary?.from) d.replyRecipients = [summary.from];
    d.subject = String(summary?.subject || "");
  }
  // The original is known now: pick From again from the address it reached,
  // unless the user chose one meanwhile.
  if (!d.fromWasChosen) d.fromEmail = "";
  draftSignal.set(d);
  ensureFrom();
  placeBody(summary, body);
  if (d.mode === "forward" && d.originalAttachments.length > 0) loadForwardAttachments();
}

function readParts(accountId: string, messageId: string, listed: any[]) {
  const host = composeHost();
  return Promise.all(
    listed.map(async (source) => {
      try {
        const data = await host.attachment(accountId, messageId, String(source?.attachmentId || ""));
        return { file: { filename: String(source?.filename || "attachment"), mimeType: String(source?.mimeType || "application/octet-stream"), size: Math.max(0, Math.floor(Number(source?.size) || 0)), data }, error: "" };
      } catch (error) {
        return { file: null, error: `Could not include ${String(source?.filename || "an attachment")}: ${String((error as Error)?.message || error)}` };
      }
    }),
  ).then((rows) => {
    const failure = rows.find((r) => r.error)?.error ?? "";
    return { files: rows.map((r) => r.file).filter(Boolean) as Attachment[], error: failure };
  });
}

/** Reads a forward's original parts. Sending waits for them, or for Retry. */
export function loadForwardAttachments() {
  const d = draftSignal();
  if (d.mode !== "forward" || d.originalAttachments.length === 0) return;
  const serial = ++forwardLoadSerial;
  batch(() => {
    forwardLoadingSignal.set(true);
    forwardErrorSignal.set("");
    draftSignal.set({ ...d, forwardedAttachments: [] });
  });
  const message = d.replyMessageId || untracked(() => app.selectedId());
  readParts(d.accountId, Draft.sourceIdOf(message), d.originalAttachments).then(({ files, error }) => {
    if (serial !== forwardLoadSerial || !openedSignal() || draftSignal().mode !== "forward") return;
    batch(() => {
      forwardLoadingSignal.set(false);
      forwardErrorSignal.set(error);
      draftSignal.set({ ...draftSignal(), forwardedAttachments: error ? [] : files });
    });
  });
}

/** Where the open draft's files are read from, for Retry. */
let draftFiles = { accountId: "", messageId: "", link: false };

/** Reads a saved draft's parts; `link`: link the draft to its saved copy once they are in. */
function loadDraftAttachments(accountId: string, messageId: string, listed: any[], link = false) {
  draftFiles = { accountId, messageId, link };
  const d = draftSignal();
  draftSignal.set({ ...d, originalAttachments: listed.slice(), ...(link && listed.length === 0 ? { sourceDraftId: messageId } : {}) });
  if (listed.length === 0) return;
  const serial = ++forwardLoadSerial;
  forwardLoadingSignal.set(true);
  forwardErrorSignal.set("");
  readParts(accountId, messageId, listed).then(({ files, error }) => {
    if (serial !== forwardLoadSerial || !openedSignal() || draftSignal().mode !== "draft") return;
    forwardLoadingSignal.set(false);
    forwardErrorSignal.set(error);
    if (error) {
      fail(error);
      return;
    }
    const d = draftSignal();
    // Files the user attached meanwhile stay; the link holds only while the
    // draft still belongs to the mailbox whose saved copy it would replace.
    draftSignal.set({
      ...d,
      draftAttachments: [...files, ...d.draftAttachments],
      ...(link && d.accountId === accountId ? { sourceDraftId: messageId } : {}),
    });
  });
}

/** Retry on the original attachments' error: a draft's own, else a forward's. */
export function retryOriginalAttachments() {
  const d = draftSignal();
  if (d.mode === "draft") loadDraftAttachments(draftFiles.accountId, draftFiles.messageId, d.originalAttachments, draftFiles.link);
  else loadForwardAttachments();
}

/** Reopens a stored draft (recovery, an undone send). */
function restoreDraft(saved: ComposeDraft) {
  const d = Draft.restore(saved);
  draftSignal.set(d);
  show();
  // Files kept by path come back through the backend, never from the record's word alone.
  const keep: Attachment[] = [];
  const recover: Attachment[] = [];
  for (const file of d.draftAttachments) {
    if (String(file?.path || "") !== "" && String(file?.data || "") === "") recover.push(file);
    else keep.push(file);
  }
  if (recover.length > 0) {
    draftSignal.set({ ...d, draftAttachments: keep });
    for (const file of recover) enqueueAttach(file.owned === true ? "recover-owned" : "recover", String(file.path));
  }
  if (d.mode === "forward" && d.originalAttachments.length > 0 && d.forwardedAttachments.length === 0) loadForwardAttachments();
}

/** The draft closes: the next held one reopens, or compose goes away. */
function finish() {
  clearCurrent(true);
  const held = interruptedSignal();
  if (held) {
    interruptedSignal.set(null);
    restoreDraft(held);
    scheduleRecovery();
    return;
  }
  const queued = recoveryDraftsSignal();
  if (queued.length > 0) {
    recoveryDraftsSignal.set(queued.slice(1));
    restoreDraft(queued[0]);
    scheduleRecovery();
    return;
  }
  close();
}

function closeWindow() {
  if (!windowedSignal()) return;
  windowedSignal.set(false);
  if (windowHooks?.isOpen()) windowHooks.close();
}

function close() {
  batch(() => {
    openedSignal.set(false);
    exitDialogSignal.set(false);
  });
  closeWindow();
  if (app.composing()) app.closeOverlay();
  if (parkedSignal().length > 0) scheduleRecovery();
  else clearRecovery();
}

// --------------------------------------------------------------- leaving

/** Back, Escape or the close button: ask when the user changed something. */
export function requestLeave() {
  if (!openedSignal()) return;
  if (!draftSignal().userModified) {
    finish();
    return;
  }
  exitDialogSignal.set(true);
}

export function cancelLeave() {
  exitDialogSignal.set(false);
}

/** Discard: the draft and the files it made go; a saved provider draft stays. */
export function discard() {
  exitDialogSignal.set(false);
  finish();
}

/** Save draft: the editor closes at once and the provider save runs behind it. */
export function saveAndLeave(force = false) {
  exitDialogSignal.set(false);
  if (!openedSignal()) return;
  const d = draftSignal();
  if (!force && !Draft.meaningful(d)) {
    finish();
    return;
  }
  const saved = Draft.snapshot(d);
  const revision = saveRecovery(saved);
  // Detach: close (or reopen what was held) without forgetting the files the save needs.
  clearCurrent(false);
  const held = interruptedSignal();
  if (held) {
    interruptedSignal.set(null);
    restoreDraft(held);
  } else {
    close();
    // close() cleared recovery; the record must hold this draft until the save lands.
    saveRecovery(saved);
  }
  saveProviderDraft(Draft.fieldsForDraft(saved)).then(
    (result) => {
      owned(saved.draftAttachments);
      if (openedSignal() || parkedSignal().length > 0) scheduleRecovery();
      else clearRecovery(revision + 1);
      const warning = String(result?.warning || "");
      toast({ title: warning === "" ? "Draft saved" : warning, kind: warning === "" ? "success" : "warning", id: "draft-saved" });
    },
    (error) => {
      recoverDetachedSave(saved);
      fail("Could not save draft: " + String((error as Error)?.message || error));
    },
  );
}

function recoverDetachedSave(saved: ComposeDraft) {
  if (!openedSignal()) {
    restoreDraft(saved);
    scheduleRecovery();
    return;
  }
  recoveryDraftsSignal.set([...recoveryDraftsSignal(), saved]);
  scheduleRecovery();
}

/** The fields `message.compose` takes, through the owning mailbox's alias list. */
function composeFields(values: Draft.DraftFields, accountId: string, exactBody: boolean) {
  const host = composeHost();
  const from = String(values.from || "").trim();
  const alias = from === "" ? null : Senders.sendAsFor(host.aliasesFor(accountId), from);
  if (from !== "" && !alias) throw new Error("Choose a valid From address");
  const signature = host.signatureFor(accountId);
  return {
    from,
    fromName: alias ? String(alias.displayName || "") : "",
    accountAddress: host.ownAddressFor(accountId),
    to: addressList(values.to),
    cc: addressList(values.cc),
    bcc: addressList(values.bcc),
    replyTo: addressList(values.replyTo),
    signature: signature.text,
    signatureHtml: signature.html,
    subject: String(values.subject || ""),
    body: exactBody ? String(values.body || "") : String(values.body || "").trim(),
    attachments: values.attachments,
    threadId: values.threadId,
    inReplyTo: values.inReplyTo,
    draftId: Draft.sourceIdOf(values.draftId),
  };
}

function ownerOf(values: { accountId?: string; draftId?: string }): string {
  const owner = Draft.draftOwner(values);
  if (owner !== "" && !app.accounts().some((a) => a.id === owner)) return "";
  return owner;
}

async function saveProviderDraft(values: Draft.DraftFields): Promise<any> {
  const accountId = ownerOf(values);
  if (accountId === "") throw new Error("The mailbox for this draft is unavailable");
  const fields = composeFields(values, accountId, true);
  let payload: Record<string, any>;
  try {
    payload = await call("message.compose", { fields });
  } catch {
    throw new Error("Could not prepare this draft");
  }
  return composeHost().saveDraft(accountId, payload);
}

// ------------------------------------------------------------------ send


function delaySeconds(): number {
  const host = composeHost();
  return normalizeDelay(host.undoSendSeconds ? host.undoSendSeconds() : undefined);
}

function queueFor(accountId: string): SendQueue {
  const existing = queuesSignal().get(accountId);
  if (existing) return existing;
  const queue = new SendQueue({
    accountId,
    provider: () => composeHost().providerFor(accountId),
    delaySeconds,
    request: (method, params) => call(method, params),
    sent: (id, entry) => {
      const warning = entry.result?.warning ? String(entry.result.warning) : "";
      note(warning !== "" ? warning : "Sent");
      queueMicrotask(() => completePendingSend(id));
    },
    failed: (id, message) => {
      fail(message);
      queueMicrotask(() => {
        if (restoreParkedDraft(id, true)) scheduleRecovery();
      });
    },
    note,
  });
  const next = new Map(queuesSignal());
  next.set(accountId, queue);
  queuesSignal.set(next);
  queue.sync();
  return queue;
}

function latestQueue(): SendQueue | null {
  let best: SendQueue | null = null;
  let bestAt = -Infinity;
  for (const queue of queuesSignal().values()) {
    const latest: OutboxEntry | null = queue.latest();
    if (latest && Number(latest.queuedAt || 0) >= bestAt) {
      best = queue;
      bestAt = Number(latest.queuedAt || 0);
    }
  }
  return best;
}

/** Send (the button or Ctrl+Enter): checks, parks the draft for the undo window, queues it. */
export function send() {
  if (!openedSignal() || !compose.canSend()) return;
  const d = draftSignal();
  const values = Draft.fieldsForDraft(d);
  const accountId = ownerOf({ accountId: d.accountId, draftId: d.sourceDraftId });
  if (accountId === "") {
    fail("This draft belongs to an unavailable account.");
    return;
  }
  const hasFiles = values.attachments.some((f) => f && (f.data || f.path));
  if (values.body.trim() === "" && !hasFiles) {
    fail("Write something before sending");
    return;
  }
  if (addressList(values.to) === "") {
    fail("Add a recipient first");
    return;
  }
  let fields: ReturnType<typeof composeFields>;
  try {
    fields = composeFields(values, accountId, false);
  } catch (error) {
    fail(String((error as Error).message));
    return;
  }
  sendSequence += 1;
  void queueSend(`send-${sendSession}-${sendSequence}`, fields, accountId);
}

/** Parks the draft and hands its message to the owning mailbox's outbox. */
async function queueSend(id: string, fields: ReturnType<typeof composeFields>, accountId: string, draft?: ComposeDraft): Promise<boolean> {
  const order = ++sendSequence;
  parkForSend(id, draft);
  const queue = queueFor(accountId);
  try {
    const payload = await call<Record<string, any>>("message.compose", { fields });
    if (!payload) throw new Error("empty");
    payload.draftId = fields.draftId;
    payload.sendId = id;
    queue.park(payload, id, order);
    startUndoToast();
    return true;
  } catch {
    fail("Could not prepare this message");
    if (restoreParkedDraft(id, true)) scheduleRecovery();
    return false;
  }
}

/**
 * Parks a draft for its send. `draft` is a draft other than the editor's (an
 * AI proposal sent from the dock): the editor closes only when it holds that
 * same draft, so an unrelated draft being written stays open.
 */
function parkForSend(sendId: string, draft?: ComposeDraft) {
  const saved = draft ?? Draft.snapshot(draftSignal());
  if (!parkedSignal().some((p) => p.sendId === sendId)) parkedSignal.set([...parkedSignal(), { sendId, draft: saved }]);
  if (draft && (!openedSignal() || draftSignal().draftKey !== draft.draftKey)) {
    scheduleRecovery();
    return;
  }
  clearCurrent(false);
  const held = interruptedSignal();
  if (held) {
    interruptedSignal.set(null);
    restoreDraft(held);
    scheduleRecovery();
    return;
  }
  batch(() => {
    openedSignal.set(false);
    exitDialogSignal.set(false);
  });
  closeWindow();
  if (app.composing()) app.closeOverlay();
  scheduleRecovery();
}

/**
 * The parked draft a send names, or (for an undo that names none) the newest;
 * the oldest for an answer, since sends go in the order they were asked. A
 * name not parked here belongs to no draft: the wrong words never come back.
 */
function takeParked(sendId: string, oldest: boolean): ComposeDraft | null {
  const parked = parkedSignal().slice();
  if (parked.length === 0) return null;
  let index: number;
  if (sendId !== "") {
    index = parked.findIndex((p) => p.sendId === sendId);
    if (index < 0) return null;
  } else index = oldest ? 0 : parked.length - 1;
  const [entry] = parked.splice(index, 1);
  parkedSignal.set(parked);
  return entry.draft;
}

function completePendingSend(sendId: string) {
  const draft = takeParked(sendId, true);
  if (!draft) return;
  owned(draft.draftAttachments);
  if (openedSignal() || parkedSignal().length > 0) scheduleRecovery();
  else clearRecovery();
}

/** A send that did not happen, or was undone: its draft comes back in front of the writer. */
function restoreParkedDraft(sendId: string, oldest: boolean): boolean {
  const named = parkedSignal().find((p) => p.sendId === sendId);
  const receiptAccount = named ? String(named.draft.accountId || "") : "";
  const draft = takeParked(sendId, oldest);
  if (!draft) return false;
  if (openedSignal()) {
    const displaced = Draft.snapshot(draftSignal());
    if (interruptedSignal()) recoveryDraftsSignal.set([...recoveryDraftsSignal(), displaced]);
    else interruptedSignal.set(displaced);
  }
  clearCurrent(false);
  restoreDraft(draft);
  const revision = saveRecovery();
  if (receiptAccount !== "" && sendId !== "") queueReceiptAck(receiptAccount, sendId, revision);
  // The draft that was open is saved to the provider so it is not lost behind this one.
  const interrupted = interruptedSignal();
  if (interrupted && Draft.meaningful(interrupted)) {
    saveProviderDraft(Draft.fieldsForDraft(interrupted)).then(
      () => {
        if (interruptedSignal() !== interrupted) return;
        owned(interrupted.draftAttachments);
        interruptedSignal.set(null);
        toast({ title: "Draft saved", kind: "success", id: "draft-saved" });
        scheduleRecovery();
      },
      (error) => fail("Could not save the newer draft: " + String((error as Error)?.message || error)),
    );
  }
  return true;
}

/** Undo send (Alt+Z or the toast): the newest parked send comes back as its draft. */
export function undoSend(): boolean {
  const queue = latestQueue();
  if (!queue) return false;
  return queue.undoLatest((id) => {
    if (id) restoreParkedDraft(id, false);
  });
}

// The undo window's notice, renamed in place as the seconds pass.
let undoTimer: number | null = null;
let undoShown = "";

function undoTitle(): string {
  const count = compose.sendPendingCount();
  const seconds = compose.sendSeconds();
  return count > 1 ? `${count} queued · newest in ${seconds}s` : `Sending in ${seconds}s`;
}

function startUndoToast() {
  const tick = () => {
    if (compose.sendPendingCount() === 0 || parkedSignal().length === 0) {
      if (undoTimer !== null) clearInterval(undoTimer);
      undoTimer = null;
      if (undoShown !== "") dismissToast("undo-send");
      undoShown = "";
      return;
    }
    const title = undoTitle();
    if (title === undoShown) return;
    undoShown = title;
    toast({
      id: "undo-send",
      title,
      kind: "info",
      timeout: null,
      action: { label: compose.sendPendingCount() > 1 ? "Undo last" : "Undo", onAction: () => void undoSend() },
    });
  };
  tick();
  if (undoTimer === null) undoTimer = setInterval(tick, 250);
}

// ----------------------------------------------------------- attachments

const attachJobs: AttachJob[] = [];
let attachBusy = false;

function enqueueAttach(mode: AttachJob["mode"], path: string) {
  attachJobs.push({ mode, path: String(path || "") });
  pumpAttach();
}

function pumpAttach() {
  if (attachBusy || attachJobs.length === 0) {
    attachingSignal.set(attachBusy || attachJobs.length > 0);
    return;
  }
  const job = attachJobs.shift()!;
  const owner = draftSignal().draftKey;
  attachBusy = true;
  attachingSignal.set(true);
  const method = job.mode === "forget" ? "attachment.forget" : "attachment.read";
  call<any>(method, { path: job.path }).then(
    (result) => finishAttach(job, result, owner),
    (error) => {
      const code = String((error as Error)?.message || "");
      finishAttach(job, { ok: false, error: code === "attachment_too_large" ? Draft.TOO_LARGE : "That file could not be read" }, owner);
    },
  );
}

function finishAttach(job: AttachJob, result: any, owner: string) {
  attachBusy = false;
  // A late read must not put an old draft's file into the next one.
  if (job.mode !== "forget" && owner !== draftSignal().draftKey) {
    pumpAttach();
    return;
  }
  if (job.mode === "forget") {
    pumpAttach();
    return;
  }
  if (!result || result.ok !== true) {
    fail(result && result.error ? String(result.error) : "That file could not be attached");
    pumpAttach();
    return;
  }
  addAttachment(
    {
      filename: String(result.filename || "attachment"),
      mimeType: String(result.mimeType || "application/octet-stream"),
      size: Math.max(0, Math.floor(Number(result.size) || 0)),
      data: String(result.data || ""),
      path: String(result.path || ""),
      owned: job.mode === "recover-owned",
    },
    job.mode === "read",
  );
  pumpAttach();
}

function addAttachment(entry: Attachment, user: boolean) {
  const d = draftSignal();
  const next = { ...d, draftAttachments: [...d.draftAttachments, entry] };
  draftSignal.set(user ? { ...next, userModified: true } : next);
  if (user) scheduleRecovery();
}

async function fileEntry(file: File, name: string, type: string): Promise<Attachment | null> {
  if (file.size > Draft.MAX_ATTACHMENT_BYTES) {
    fail(Draft.TOO_LARGE);
    return null;
  }
  const bytes = await file.arrayBuffer();
  return {
    filename: String(name || file.name || "attachment"),
    mimeType: String(type || file.type || "application/octet-stream"),
    size: bytes.byteLength,
    data: Buffer.from(bytes).toString("base64"),
    path: "",
    owned: false,
  };
}

/** Attach... : the system's file picker. Bytes stay in the draft; nothing is written to disk. */
export async function chooseFiles() {
  const owner = draftSignal().draftKey;
  attachingSignal.set(true);
  try {
    const picked = await Picker.pickFiles({ multiple: true, maxSize: Draft.MAX_ATTACHMENT_BYTES });
    for (const item of picked) {
      if (draftSignal().draftKey !== owner) return;
      if (item.status !== "read" || !item.file) {
        fail(Draft.TOO_LARGE);
        continue;
      }
      const entry = await fileEntry(item.file, item.name, item.type);
      if (entry && draftSignal().draftKey === owner) addAttachment(entry, true);
    }
  } catch {
    fail("That file could not be attached");
  } finally {
    attachingSignal.set(attachBusy || attachJobs.length > 0);
  }
}

/**
 * Files dropped on the window. Bytes the platform read win; otherwise local
 * paths go through the backend reader (it checks the path and the size).
 */
export function attachDropped(uris: string[], files: { file: File | null; name: string; type: string; status: string }[] = []) {
  if (files.length > 0) {
    void attachFiles(files);
    return;
  }
  for (const uri of uris) {
    const path = Draft.pathFromUri(uri);
    if (path !== "") enqueueAttach("read", path);
  }
}

/** Pasted images (screenshots) and files copied in a file manager. */
export function attachPasted(files: File[], uris: string[], tooLarge: number) {
  if (tooLarge > 0) fail(Draft.TOO_LARGE);
  for (const uri of uris) {
    const path = Draft.pathFromUri(uri);
    if (path !== "") enqueueAttach("read", path);
  }
  void attachFiles(files.map((file) => ({ file, name: file.name || "pasted-image", type: file.type, status: "read" })));
}

async function attachFiles(files: { file: File | null; name: string; type: string; status: string }[]) {
  const owner = draftSignal().draftKey;
  for (const item of files) {
    if (item.status !== "read" || !item.file) {
      fail(Draft.TOO_LARGE);
      continue;
    }
    const entry = await fileEntry(item.file, item.name, item.type);
    if (entry && draftSignal().draftKey === owner) addAttachment(entry, true);
  }
}

export function removeAttachment(index: number) {
  const d = draftSignal();
  const forwarded = d.mode === "forward" ? d.forwardedAttachments.length : 0;
  if (index < forwarded) {
    // A forwarded original is part of what the forward carries; removing one drops it.
    const kept = d.forwardedAttachments.filter((_, i) => i !== index);
    update({ forwardedAttachments: kept });
    return;
  }
  const at = index - forwarded;
  const list = d.draftAttachments.slice();
  if (at < 0 || at >= list.length) return;
  const [entry] = list.splice(at, 1);
  update({ draftAttachments: list });
  if (entry && entry.owned && entry.path) enqueueAttach("forget", entry.path);
}

// -------------------------------------------------------------- contacts

let contactsAt = 0;
let googleAt: Record<string, number> = {};

/** The contact book: addresses seen in mail, plus Google contacts for Gmail mailboxes (at most every 30 minutes). */
export function refreshContacts() {
  const now = Date.now();
  if (now - contactsAt > 60_000) {
    contactsAt = now;
    call<any>("contacts.suggest", {}).then(
      (rows) => mergeContacts(Array.isArray(rows) ? rows : Array.isArray(rows?.contacts) ? rows.contacts : []),
      () => {},
    );
  }
  for (const account of app.accounts()) {
    if (account.provider !== "gmail" && account.provider !== "") continue;
    if (now - (googleAt[account.id] ?? 0) < 30 * 60_000) continue;
    googleAt = { ...googleAt, [account.id]: now };
    call<any>("contacts.google", { accountId: account.id }).then(
      (result) => mergeContacts(Array.isArray(result?.contacts) ? result.contacts : []),
      () => {},
    );
  }
}

function mergeContacts(rows: unknown[]) {
  contactsSignal.set(Recipients.normalize([...contactsSignal(), ...rows]));
}

function refreshIdentities() {
  composeHost()
    .identities()
    .then(
      (rows) => {
        identitiesSignal.set(rows);
      },
      () => {},
    );
}

// -------------------------------------------------------------- recovery

let storageRevision = "";
let recoveryLoaded = false;
let localRevision = 0;
let committedRevision = 0;
let lastText = "";
let writePayload = "";
let writeQueued = false;
let writing = false;
let conflict = false;
let retries = 0;
let retryTimer: number | null = null;
let saveTimer: number | null = null;
let pendingRestore: Recovery.RecoveryRecord | null = null;
let receiptAcks: { accountId: string; sendId: string; revision: number }[] = [];

function returnView(): Recovery.ReturnView {
  if (app.calendarVisible()) return "calendar";
  return app.readerOpen() ? "reader" : "list";
}

function scheduleRecovery() {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveRecovery();
  }, 400);
}

/** The drafts besides `draft` the record keeps: parked ones with their send ids, then held ones. */
function besides(draft: ComposeDraft | null): ComposeDraft[] {
  const out: ComposeDraft[] = [];
  for (const p of parkedSignal()) if (p.draft !== draft) out.push({ ...p.draft, pendingSendId: p.sendId });
  const held = interruptedSignal();
  if (held && held !== draft) out.push(held);
  for (const r of recoveryDraftsSignal()) if (r !== draft) out.push(r);
  return out;
}

/** Writes what would be lost to a crash now. Returns the local revision it took. */
function saveRecovery(saved?: ComposeDraft): number {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  let draft: ComposeDraft | null = saved ?? (openedSignal() ? Draft.snapshot(draftSignal()) : null);
  let rest = besides(null);
  if (!draft && rest.length > 0) {
    draft = rest[0];
    rest = rest.slice(1);
  }
  if (!draft) {
    clearRecovery();
    return localRevision;
  }
  const record = Recovery.record(returnView(), draft, rest);
  const raw = JSON.stringify(record);
  if (raw === lastText) return localRevision;
  localRevision++;
  lastText = raw;
  writeRecovery(raw);
  return localRevision;
}

function clearRecovery(expectedRevision?: number): boolean {
  if (expectedRevision !== undefined && expectedRevision !== localRevision) return false;
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  localRevision++;
  if (lastText === "") return true;
  lastText = "";
  writeRecovery(Recovery.INACTIVE);
  return true;
}

function writeRecovery(raw: string) {
  writePayload = raw;
  writeQueued = true;
  if (!recoveryLoaded || storageRevision === "") readRecovery();
  else drainRecovery();
}

function drainRecovery() {
  if (conflict || writing || !writeQueued || !recoveryLoaded || storageRevision === "") return;
  const raw = writePayload;
  const mine = localRevision;
  writeQueued = false;
  writing = true;
  call<{ revision?: string; record?: any }>("compose.recoverySave", { record: JSON.parse(raw), expectedRevision: storageRevision }).then(
    (result) => {
      writing = false;
      retries = 0;
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      storageRevision = String(result?.revision || "");
      committedRevision = Math.max(committedRevision, mine);
      if (recoveryNoticeSignal() === SAVE_FAILED) recoveryNoticeSignal.set("");
      acknowledgeReceipts();
      if (mine === localRevision && !writeQueued) writePayload = "";
      drainRecovery();
    },
    (error: any) => {
      writing = false;
      // Keep the live draft. A stale window must never overwrite another
      // instance's saved recovery by retrying with a fresh revision.
      writeQueued = true;
      conflict = error?.message === "recovery_conflict";
      recoveryNoticeSignal.set(error?.code === -32601 ? UPDATE_NEEDED : SAVE_FAILED);
      if (!conflict && Recovery.UNSENT_REFUSALS.includes(Number(error?.code)) && retries < Recovery.MAX_RETRIES) {
        retries++;
        retryTimer = setTimeout(drainRecovery, Recovery.retryDelay(retries));
      }
    },
  );
}

const SAVE_FAILED = "Draft recovery could not be saved. Keep this window open.";
const UPDATE_NEEDED = "Draft recovery needs an updated backend. Keep this window open.";
const CHECKING = "Checking whether the recovered message was sent. Reconnect the mail backend.";
const UNAVAILABLE = "This draft belongs to an unavailable account.";

let reading = false;

function readRecovery() {
  if (reading) return;
  reading = true;
  const mine = localRevision;
  call<{ revision?: string; record?: any }>("compose.recoveryRead", {}).then(
    (result) => {
      reading = false;
      if (conflict && writeQueued) return;
      storageRevision = String(result?.revision || "");
      const first = !recoveryLoaded;
      recoveryLoaded = true;
      if (first && localRevision === mine && writePayload === "") {
        committedRevision = mine;
        if (result?.record?.active === true) reconcileRecovered(result.record as Recovery.RecoveryRecord);
      }
      drainRecovery();
    },
    (error: any) => {
      reading = false;
      if (error?.code === -32601) recoveryNoticeSignal.set(UPDATE_NEEDED);
    },
  );
}

/** Asks the outbox what became of each recovered draft's send before reopening anything. */
async function reconcileRecovered(record: Recovery.RecoveryRecord) {
  const drafts = Recovery.draftsOf(record);
  const pending = Recovery.pendingDrafts(record);
  const states: Record<string, Recovery.DeliveryState> = {};
  for (const draft of pending) {
    try {
      const result = await call<any>("outbox.snapshot", { accountId: String(draft.accountId || ""), sendId: String(draft.pendingSendId) });
      if (!result || !Array.isArray(result.entries)) throw new Error("no entries");
      states[Recovery.stateKey(String(draft.accountId), String(draft.pendingSendId))] = result.entries.length
        ? (String(result.entries[0].state || "unknown") as Recovery.DeliveryState)
        : "missing";
    } catch {
      recoveryNoticeSignal.set(CHECKING);
      return;
    }
  }
  const result = Recovery.reconcile(drafts, states);
  // Sends that may still go stay parked; their queue reports the outcome.
  const parked = parkedSignal().slice();
  for (const waiting of result.waiting) {
    const id = String(waiting.pendingSendId);
    if (!parked.some((p) => p.sendId === id && p.draft.accountId === waiting.accountId)) {
      const draft = { ...waiting };
      delete draft.pendingSendId;
      parked.push({ sendId: id, draft });
      queueFor(String(waiting.accountId));
    }
  }
  parkedSignal.set(parked);
  const updated = Recovery.afterReconcile(record.returnView, result);
  localRevision++;
  lastText = updated ? JSON.stringify(updated) : "";
  writeRecovery(updated ? lastText : Recovery.INACTIVE);
  for (const receipt of result.receipts) queueReceiptAck(receipt.accountId, receipt.sendId, localRevision);
  if (result.restored.length > 0) {
    pendingRestore = updated;
    restoreRecovered();
  }
}

function restoreRecovered() {
  const record = pendingRestore;
  if (!record || !record.draft || openedSignal()) return;
  const accounts = app.accounts();
  // Accounts load after the backend: wait for them rather than calling a draft orphaned.
  if (accounts.length === 0) return;
  const restored = [record.draft, ...(record.parked ?? [])].filter((d) => String(d.pendingSendId || "") === "");
  if (restored.length === 0) {
    pendingRestore = null;
    return;
  }
  const first = restored[0];
  if (first.accountId && !accounts.some((a) => a.id === first.accountId)) {
    recoveryNoticeSignal.set(UNAVAILABLE);
    // Compose is closed, so say it where the window shows notices too.
    toast({ title: UNAVAILABLE, kind: "warning", id: "compose-recovery" });
    pendingRestore = null;
    return;
  }
  pendingRestore = null;
  if (first.deliveryUnknown === true) recoveryNoticeSignal.set("Delivery status is unknown. Check Sent before trying again.");
  restoreDraft(first);
  if (restored.length > 1) recoveryDraftsSignal.set([...recoveryDraftsSignal(), ...restored.slice(1)]);
}

function queueReceiptAck(accountId: string, sendId: string, revision: number) {
  if (accountId === "" || sendId === "") return;
  receiptAcks = receiptAcks.filter((e) => e.accountId !== accountId || e.sendId !== sendId);
  receiptAcks.push({ accountId, sendId, revision });
  acknowledgeReceipts();
}

const ackBusy = new Set<string>();

/** Forgets a terminal send only once the record that no longer needs it has landed. */
function acknowledgeReceipts() {
  for (const entry of receiptAcks.slice()) {
    const key = entry.accountId + "\n" + entry.sendId;
    if (entry.revision > committedRevision || ackBusy.has(key)) continue;
    ackBusy.add(key);
    call<any>("outbox.snapshot", { accountId: entry.accountId, sendId: entry.sendId })
      .then(async (result) => {
        const state = result?.entries?.[0]?.state ?? "";
        if (state !== "sent" && state !== "cancelled" && state !== "failed") return;
        await call("outbox.forget", { accountId: entry.accountId, sendId: entry.sendId });
        receiptAcks = receiptAcks.filter((e) => e !== entry);
      })
      .catch(() => {})
      .finally(() => ackBusy.delete(key));
  }
}

// ------------------------------------------------------------- the window

let windowHooks: { close: () => void; isOpen: () => boolean } | null = null;

/** The surface's window (index.tsx): how compose closes it and sees it closed. */
export function setWindowHooks(hooks: { close: () => void; isOpen: () => boolean }) {
  windowHooks = hooks;
}

/**
 * Shows compose in a desktop window of its own, or back over the mail. The
 * draft is the same either way: moving it never saves, sends or drops it.
 */
export function setWindowed(windowed: boolean) {
  if (windowed === windowedSignal()) return;
  windowedSignal.set(windowed);
  if (windowed) {
    if (app.composing()) app.closeOverlay();
    return;
  }
  if (windowHooks?.isOpen()) windowHooks.close();
  if (openedSignal() && !app.composing()) app.openOverlay("compose");
}

/** The surface asks the next keyboard placement. */
export function requestFocus() {
  focusRequestSignal.update((n) => n + 1);
}

// ------------------------------------------------------------------ start

let started = false;

/** Wires the app-wide parts once: recovery, outbox notifications, mailto links, Alt+Z. */
export function startCompose() {
  if (started) return;
  started = true;
  setAccountsSource(() => app.accounts());
  void loadRegistry();
  readRecovery();
  on("outbox.changed", (params) => {
    const accountId = String(params?.accountId || "");
    if (accountId !== "") queuesSignal().get(accountId)?.apply(params);
  });
  // Undo send answers anywhere, compose open or not (docs/KEYS.md).
  registerCommand("undoSend", () => void undoSend());
  // A new message from anywhere (the header's Compose, its key): a real draft,
  // with its mailbox and From, never the bare overlay. A feature that edits
  // the draft under the cursor registers "compose" later and wins.
  registerCommand("compose", () => openCompose());
  // The overlay reached without a draft (history, an older caller): start one.
  effect(() => {
    if (!app.composing() || openedSignal()) return;
    queueMicrotask(() => {
      if (app.composing() && !untracked(openedSignal)) openCompose();
    });
  });
  // From follows the mailboxes and their send-as rows as they load.
  effect(() => {
    app.accounts();
    identitiesSignal();
    openedSignal();
    const d = draftSignal();
    void d.accountId;
    void d.fromEmail;
    untracked(ensureFrom);
  });
  // mailto: links arrive through the shell (src/shell/launch.ts), which calls
  // openCompose({ mailto }); NSH does not let an app claim the scheme itself.
  // Recovered drafts wait for the account list; reopen once it arrives.
  let lastCount = -1;
  let ticks = 0;
  setInterval(() => {
    ticks++;
    // The backend may start after this module: keep asking for the record.
    if (!recoveryLoaded && !reading && ticks % 4 === 0) readRecovery();
    // The user closed compose's own window: the draft comes back over the mail.
    if (windowedSignal() && windowHooks && !windowHooks.isOpen()) setWindowed(false);
    const count = app.accounts().length;
    if (count !== lastCount) {
      lastCount = count;
      restoreRecovered();
      for (const account of app.accounts()) queueFor(account.id);
    }
  }, 500);
}

/** The draft compose would write to recovery now (tests, the assistant). */
export function snapshotDraft(): ComposeDraft {
  return Draft.snapshot(draftSignal());
}

/** Payload helper for the shell's open requests (`{mailto}` / `{compose:true}`). */
export function openFromPayload(payload: unknown): boolean {
  const fields = Mailto.draftFromPayload(payload);
  if (!fields) return false;
  openCompose(fields);
  return true;
}

// ------------------------------------------------------------- assistant

/** Opens an AI proposal as a draft of its own; an open draft with changes is kept for later. */
export function beginProposalDraft(saved: unknown) {
  setAsideOpen();
  clearCurrent(false);
  restoreDraft(saved as ComposeDraft);
  scheduleRecovery();
}

/**
 * Sends an AI proposal the owner pressed "Send email" on, exactly as shown
 * (`exactBody`), through the mailbox the proposal belongs to and its outbox.
 * The From must be one of that mailbox's addresses, as for any send.
 */
export async function sendProposalDraft(saved: unknown, sendId: string): Promise<{ ok: boolean; error?: string }> {
  const draft = Draft.restore(saved);
  const values = Draft.fieldsForDraft(draft);
  const accountId = ownerOf({ accountId: draft.accountId, draftId: draft.sourceDraftId });
  if (accountId === "") return { ok: false, error: "This draft belongs to an unavailable account." };
  if (addressList(values.to) === "") return { ok: false, error: "Add a recipient first" };
  if (parkedSignal().some((p) => p.sendId === sendId)) return { ok: true };
  let fields: ReturnType<typeof composeFields>;
  try {
    fields = composeFields(values, accountId, true);
  } catch (error) {
    return { ok: false, error: String((error as Error).message) };
  }
  const ok = await queueSend(sendId, fields, accountId, draft);
  return ok ? { ok } : { ok, error: "Could not queue the email. Try again." };
}

/** Where the outbox has `sendId` got to, as its mailbox's queue last heard. */
export function deliveryStateOf(accountId: string, sendId: string): string {
  const queue = queuesSignal().get(String(accountId || ""));
  return queue ? String(queue.deliveryStates()[String(sendId || "")] || "") : "";
}
