// The open message: what the reader shows and every answer it gives. Port of
// the reading half of omarchy/ui/account/MailAccount.qml (select,
// preparedRead, renderSource, the remote-image queue, attachments, the
// invitation), account/Rsvp.qml and account/Unsubscribe.qml, with exactly
// the backend methods and params those send.
//
// Nothing here fetches a sender's resource itself. Remote pictures go through
// `public.image` (the backend's public-host worker) only after the person
// said yes, for this message ("Show images") or for all of them ("Always
// show"); everything that reaches the body is data the backend prepared.
import { batch, cleanup, computed, effect, openUrl, signal, untracked } from "nsh";
import { Backend } from "omamail-native";
import { app } from "../../app/store";
import { call } from "../../backend/client";
import { listStore } from "../list/store";
import { capabilitiesOf } from "../../mail/list/providers";
import { attachmentRequest, composeHost } from "../../mail/compose/host";
import { preferredSendAs } from "../../mail/compose/senders";
import { sentenceFor } from "../../mail/list/providers";
import * as Invitations from "../../mail/calendar/invitations";
import { eventsFromGoogle } from "../../mail/calendar/calendar";
import { calendarSettings } from "../calendar/settings";
import * as Refusals from "../../mail/message/refusals";
import { m365Check } from "../../mail/providers/m365-check";
import { sendMail, UnwritableAddress } from "../../mail/message/send";
import { parse as parseMailto } from "../../mail/compose/mailto";
import type { Summary } from "../../mail/listModel";
import type { EventSuggestion } from "../../mail/agent/events";
import * as Html from "../../mail/message/html";
import * as Images from "../../mail/message/images";
import * as Unsub from "../../mail/message/unsubscribe";
import * as Calendar from "../../mail/message/calendar";
import * as Mime from "../../mail/message/mime";
import { readerPrefs } from "./prefs";
import { openDraft } from "./compose";

// ------------------------------------------------------------------ shapes

export interface Body {
  text: string;
  /** "html" when the text was made from the markup, else the plain part's. */
  source: string;
  bodyDirection: string;
}

/** `nativeRender` as reader.open / reader.render answer it. */
export interface Rendered {
  document: Html.HtmlNode | null;
  blockedImages: number;
  remoteImages: number;
  remoteImageSources: string[];
  tooHeavy: boolean;
  revision: string;
  plainText: { text: string; images: string[]; bodyDirection: string } | null;
  reader: { empty: boolean; document: Html.HtmlNode | null; blockedImages: number; tooHeavy: boolean } | null;
}

export type ReaderSummary = Summary & {
  to?: Mime.Address[];
  cc?: Mime.Address[];
  bcc?: Mime.Address[];
  replyTo?: Mime.Address | null;
  fullTime?: string;
  subjectDirection?: string;
  messageId?: string;
};

function rendered(raw: any): Rendered {
  const r = raw ?? {};
  return {
    document: r.document ?? null,
    blockedImages: Number(r.blockedImages) || 0,
    remoteImages: Number(r.remoteImages) || 0,
    remoteImageSources: Array.isArray(r.remoteImageSources) ? r.remoteImageSources.map(String) : [],
    tooHeavy: r.tooHeavy === true,
    revision: String(r.revision ?? ""),
    plainText: r.plainText
      ? {
        text: String(r.plainText.text ?? ""),
        images: Array.isArray(r.plainText.images) ? r.plainText.images.map(String) : [],
        bodyDirection: String(r.plainText.bodyDirection ?? ""),
      }
      : null,
    reader: r.reader
      ? {
        empty: r.reader.empty === true,
        document: r.reader.document ?? null,
        blockedImages: Number(r.reader.blockedImages) || 0,
        tooHeavy: r.reader.tooHeavy === true,
      }
      : null,
  };
}

function hydrate(raw: any): Partial<ReaderSummary> {
  if (!raw || typeof raw !== "object") return {};
  const out: any = { ...raw };
  if (raw.date !== undefined && !(raw.date instanceof Date)) {
    const date = raw.date ? new Date(raw.date) : null;
    out.date = date && isFinite(date.getTime()) ? date : null;
  }
  return out;
}

// ------------------------------------------------------------------ state

const openId = signal("");
const detail = signal<Partial<ReaderSummary> | null>(null);
const loading = signal(false);
const painted = signal(false);
const error = signal("");
const hasHtml = signal(false);
const readerKey = signal("");
const render = signal<Rendered | null>(null);
const body = signal<Body>({ text: "", source: "", bodyDirection: "" });
const plainImages = signal<string[]>([]);
const attachments = signal<Images.Attachment[]>([]);
const invite = signal<any>(null);
const unsubscribe = signal<Unsub.UnsubscribeInfo>(Unsub.empty());
const unsubscribing = signal(false);
const unsubscribeDone = signal("");
const remoteAllowed = signal(false);
const remoteData = signal<Record<string, string>>({});
const remoteLoading = signal(false);
const forceRich = signal(false);
const rsvpSending = signal(false);
const rsvpFallback = signal(false);
const calendarSaving = signal(false);
const calendarDone = signal(false);
const calendarMessage = signal("");
const saving = signal<Record<string, true>>({});
const suggestions = signal<EventSuggestion[]>([]);

let serial = 0;
let live = false;
let markedRead = false;
let cancelCurrent: (() => void) | null = null;
const requestPrefix = String(Date.now()) + "-" + String(Math.random()).slice(2);
let requestSerial = 0;

/** The open message as the header draws it: the read merged over the list's row. */
const summaryOf = computed<ReaderSummary | null>(() => {
  const id = openId();
  if (id === "") return null;
  const row = listStore.rowFor(id);
  const read = detail();
  if (!row && !read) return null;
  // The list's row is newer about the flags (a star, the quiet mark-read).
  const merged: any = { ...(read ?? {}), ...(row ?? {}) };
  if (read) {
    for (const key of ["from", "to", "cc", "bcc", "replyTo", "fullTime", "messageId", "subjectDirection"]) {
      if ((read as any)[key] !== undefined) merged[key] = (read as any)[key];
    }
    merged.subject = String(read.subject || row?.subject || "");
  }
  merged.id = id;
  return merged as ReaderSummary;
});

/** Where the open message lives: the account and the id its provider uses. */
function owner() {
  const id = untracked(() => openId());
  const found = listStore.ownerOf(id);
  const account = untracked(() => app.accounts()).find((a) => a.id === found.accountId) ?? null;
  return { id, accountId: found.accountId, sourceId: found.sourceId, provider: account?.provider ?? "", email: account?.email ?? "" };
}

function note(text: string) {
  app.setNotice(text);
}

function readerOptions() {
  const allowed = untracked(() => remoteAllowed());
  return { allowRemoteImages: allowed, remoteImageData: allowed ? untracked(() => remoteData()) : null, withReader: true };
}

// ------------------------------------------------------------------ opening

function reset() {
  batch(() => {
    detail.set(null);
    loading.set(false);
    painted.set(false);
    error.set("");
    hasHtml.set(false);
    readerKey.set("");
    render.set(null);
    body.set({ text: "", source: "", bodyDirection: "" });
    plainImages.set([]);
    attachments.set([]);
    invite.set(null);
    unsubscribe.set(Unsub.empty());
    unsubscribing.set(false);
    unsubscribeDone.set("");
    remoteAllowed.set(untracked(() => readerPrefs.alwaysShowImages()));
    remoteData.set({});
    remoteLoading.set(false);
    forceRich.set(false);
    rsvpSending.set(false);
    rsvpFallback.set(false);
    calendarSaving.set(false);
    calendarDone.set(false);
    calendarMessage.set("");
    saving.set({});
    suggestions.set([]);
  });
  stopImages();
}

function open(id: string) {
  serial++;
  live = false;
  markedRead = false;
  if (cancelCurrent) cancelCurrent();
  cancelCurrent = null;
  openId.set(id);
  reset();
  if (id === "") return;
  const at = owner();
  if (at.accountId === "" || at.sourceId === "") {
    error.set("Could not open that message");
    return;
  }
  loading.set(true);
  const mine = serial;
  const requestId = requestPrefix + "-" + ++requestSerial;
  let aborted = false;
  cancelCurrent = () => {
    if (aborted) return;
    aborted = true;
    call("reader.cancel", { accountId: at.accountId, requestId }).catch(() => {});
  };
  const current = () => !aborted && mine === serial;
  const read = (cached: boolean) => {
    if (!current()) return;
    const options = readerOptions();
    call<any>("reader.open", {
      accountId: at.accountId, id: at.sourceId, requestId, cacheOnly: cached, now: Date.now(), options,
    }).then((resource) => {
      if (!current()) return;
      if (resource && resource.nativeContent) apply(resource, cached, options.allowRemoteImages, mine);
      else if (!cached) failed(mine);
      if (cached) read(false);
      else loading.set(false);
    }, () => {
      if (!current()) return;
      if (cached) read(false);
      else failed(mine);
    });
  };
  read(true);
}

function failed(mine: number) {
  if (mine !== serial) return;
  loading.set(false);
  if (!untracked(() => painted())) error.set("Could not open that message");
}

function apply(resource: any, cached: boolean, allowedAtRead: boolean, mine: number) {
  if (mine !== serial || (cached && live)) return;
  if (!cached) live = true;
  const ready = rendered(resource.nativeRender);
  batch(() => {
    const native = hydrate(resource.nativeSummary);
    const before = untracked(() => detail()) ?? {};
    // Merged, not replaced: a provider whose read carries no subject (HEY reads
    // a conversation) would otherwise blank the one the list drew.
    detail.set({ ...before, ...native, subject: String(native.subject || before.subject || "") });
    hasHtml.set(resource.hasHtml === true);
    readerKey.set(resource.hasHtml === true ? String(resource.readerKey ?? "") : "");
    adopt(ready, allowedAtRead);
    const decoded = resource.nativeContent.body ?? {};
    body.set(ready.plainText
      ? { text: ready.plainText.text, source: "html", bodyDirection: ready.plainText.bodyDirection }
      : { text: String(decoded.text ?? ""), source: String(decoded.source ?? ""), bodyDirection: String(decoded.bodyDirection ?? "") });
    plainImages.set(ready.plainText ? ready.plainText.images : []);
    attachments.set(Array.isArray(resource.nativeContent.attachments) ? resource.nativeContent.attachments : []);
    unsubscribe.set(Unsub.fromMessage(resource));
    painted.set(true);
    error.set("");
  });
  const found = resource.cachedInvite || Calendar.fromPayload(resource.payload);
  if (found) invite.set(found);
  else if (!untracked(() => invite())) loadInvite(Calendar.pendingPart(resource.payload), mine);
  // Opening is reading: the row goes read once, quietly (its own Undo is noise).
  const id = untracked(() => openId());
  const row = untracked(() => listStore.rowFor(id));
  if (!markedRead && row && row.unread) {
    markedRead = listStore.act("markRead", [id], { quiet: true });
  }
}

/** Gmail describes the calendar part rather than sending it: one more read. */
function loadInvite(part: any, mine: number) {
  if (!part || !part.body || !part.body.attachmentId) return;
  loadAttachmentData({ attachmentId: String(part.body.attachmentId) }).then((data) => {
    if (mine !== serial || data === "") return;
    const found = Calendar.fromAttachment(part, data);
    if (found) invite.set(found);
  }, () => {});
}

function adopt(ready: Rendered, allowedAtRead: boolean) {
  const key = untracked(() => readerKey());
  // A preference change overtook the read: render under the current policy.
  if (key !== "" && allowedAtRead !== untracked(() => remoteAllowed())) {
    renderSource();
    return;
  }
  // Bytes already approved and fetched: keep what is painted until Rust has them.
  if (key !== "" && untracked(() => remoteAllowed()) && Object.keys(untracked(() => remoteData())).length > 0) {
    if (!untracked(() => render())) render.set(ready);
    renderSource();
    return;
  }
  applyRendered(ready);
}

function applyRendered(ready: Rendered) {
  const previous = untracked(() => render());
  if (previous && ready.revision !== "" && ready.revision === previous.revision) return;
  batch(() => {
    render.set(ready);
    if (ready.plainText) plainImages.set(ready.plainText.images);
  });
  if (untracked(() => remoteAllowed()) && !untracked(() => remoteLoading()) && ready.remoteImageSources.length > 0) {
    setTimeout(prepareRemoteImages, 0);
  }
}

let renderSerial = 0;
function renderSource() {
  const key = untracked(() => readerKey());
  if (key === "") return;
  const at = owner();
  const mine = serial;
  const rendering = ++renderSerial;
  call<any>("reader.render", { accountId: at.accountId, id: at.sourceId, readerKey: key, now: Date.now(), options: readerOptions() })
    .then((result) => {
      if (mine !== serial || rendering !== renderSerial) return;
      if (!result || !result.nativeRender) {
        note("Could not prepare this message for display");
        return;
      }
      applyRendered(rendered(result.nativeRender));
    }, () => {
      if (mine !== serial || rendering !== renderSerial) return;
      note("Could not prepare this message for display");
    });
}

// ------------------------------------------------------------------ remote images

const PAINT_MIN = 100;
const PAINT_MAX = 3000;
let imageSerial = 0;
let attempted: Record<string, true> = {};
let paintTimer: ReturnType<typeof setTimeout> | null = null;
let paintWait = PAINT_MIN;
let batchDirty = false;

function stopImages() {
  imageSerial++;
  attempted = {};
  batchDirty = false;
  if (paintTimer) clearTimeout(paintTimer);
  paintTimer = null;
  paintWait = PAINT_MIN;
}

function flushImages() {
  if (!batchDirty || !untracked(() => remoteAllowed())) return;
  batchDirty = false;
  renderSource();
}

function schedulePaint() {
  if (paintTimer) return;
  paintTimer = setTimeout(() => {
    paintTimer = null;
    flushImages();
    // The first pictures paint soon; a long queue repaints less and less often.
    paintWait = Math.min(PAINT_MAX, paintWait * 2);
    if (untracked(() => remoteLoading()) && batchDirty) schedulePaint();
  }, paintWait);
}

function prepareRemoteImages() {
  const ready = untracked(() => render());
  if (!untracked(() => remoteAllowed()) || untracked(() => remoteLoading()) || !ready) return;
  const have = untracked(() => remoteData());
  const pending = ready.remoteImageSources.filter((source, i, all) => !attempted[source] && !have[source] && all.indexOf(source) === i);
  if (pending.length === 0) return;
  const mine = ++imageSerial;
  remoteLoading.set(true);
  paintWait = PAINT_MIN;
  const next = () => {
    if (mine !== imageSerial) return;
    const source = pending.shift();
    if (source === undefined) {
      remoteLoading.set(false);
      if (paintTimer) clearTimeout(paintTimer);
      paintTimer = null;
      flushImages();
      return;
    }
    attempted[source] = true;
    call<any>("public.image", { url: source }).then((result) => {
      if (mine !== imageSerial) return;
      const data = String(result?.data ?? "");
      if (Html.isRasterDataImage(data)) {
        remoteData.set({ ...untracked(() => remoteData()), [source]: data });
        batchDirty = true;
        schedulePaint();
      }
      next();
    }, () => {
      if (mine === imageSerial) next();
    });
  };
  next();
}

/** "Show images": this message only; nothing is remembered. */
function showMessageImages() {
  if (untracked(() => remoteAllowed()) || untracked(() => readerKey()) === "") return;
  batch(() => {
    remoteAllowed.set(true);
    remoteData.set({});
  });
  renderSource();
}

/** "Always show": the standing answer, turned off again in Settings. */
function alwaysShowImages() {
  readerPrefs.setAlwaysShowImages(true);
  showMessageImages();
}

/** One picture for a plain-text marker or the viewer: bytes already here, or
 * the public-host worker for a remote address the person chose to open. */
async function displayImage(source: string): Promise<string> {
  const wanted = String(source ?? "");
  if (Html.isRasterDataImage(wanted)) return wanted;
  const have = untracked(() => remoteData())[wanted];
  if (have && Html.isRasterDataImage(have)) return have;
  if (Html.imageSourceKind(wanted) !== "remote") return "";
  try {
    const result: any = await call("public.image", { url: wanted });
    const data = String(result?.data ?? "");
    return Html.isRasterDataImage(data) ? data : "";
  } catch {
    return "";
  }
}

// ------------------------------------------------------------------ attachments

const MAX_PICTURE_BYTES = 16 * 1024 * 1024;

async function loadAttachmentData(attachment: Images.Attachment): Promise<string> {
  const at = owner();
  const request = attachmentRequest(at.provider, at.sourceId, String(attachment.attachmentId ?? ""));
  if (!request) throw new Error("That attachment is not available");
  const result: any = await call(request.method, { ...request.params, accountId: at.accountId });
  return String(result?.data ?? "");
}

function splitPath(path: string): { name: string; folder: string } {
  const at = path.lastIndexOf("/");
  return at > 0 ? { name: path.substring(at + 1), folder: path.substring(0, at) } : { name: path, folder: "" };
}

/** "Saved name to folder": the name first, because a taken name is numbered. */
export function savedNote(path: string): string {
  const { name, folder } = splitPath(path);
  return folder !== "" ? "Saved " + name + " to " + folder : "Saved " + name;
}

async function saveAttachment(attachment: Images.Attachment): Promise<string> {
  const id = String(attachment.attachmentId ?? "");
  const name = String(attachment.filename || "attachment");
  if (id === "") {
    note("That attachment is not available");
    return "";
  }
  // One save at a time per attachment: a double press is not two files.
  if (untracked(() => saving())[id]) return "";
  saving.set({ ...untracked(() => saving()), [id]: true });
  const done = () => {
    const next = { ...untracked(() => saving()) };
    delete next[id];
    saving.set(next);
  };
  const mine = serial;
  note("Saving " + name);
  let data = "";
  try {
    data = await loadAttachmentData(attachment);
  } catch {
    data = "";
  }
  if (mine !== serial) return "";
  if (data === "") {
    done();
    note("That attachment could not be loaded");
    return "";
  }
  try {
    const result: any = await call("attachment.store", { filename: name, data, open: false });
    done();
    const path = String(result?.path ?? "");
    if (path === "") throw new Error();
    note(savedNote(path));
    return path;
  } catch {
    done();
    note("That attachment could not be saved");
    return "";
  }
}

/** Opens an attachment in another application: the backend stores it in
 * Downloads, and only a regular file it wrote there is handed to the system
 * (`Backend.openDownload`), as Qt's openAttachment did with openExternal. */
async function openAttachment(attachment: Images.Attachment): Promise<void> {
  const id = String(attachment.attachmentId ?? "");
  const name = String(attachment.filename || "attachment");
  if (id === "") {
    note("That attachment is not available");
    return;
  }
  const mine = serial;
  let data = "";
  try {
    data = await loadAttachmentData(attachment);
  } catch {
    data = "";
  }
  if (mine !== serial) return;
  if (data === "") {
    note("That attachment could not be loaded");
    return;
  }
  await storeAndOpen(name, data, "That attachment could not be opened", "That attachment is not something this can open");
}

/** Stores bytes in Downloads and opens what was stored. */
async function storeAndOpen(name: string, data: string, failure: string, refused: string): Promise<boolean> {
  let path = "";
  try {
    const result: any = await call("attachment.store", { filename: name, data, open: true });
    path = String(result?.path ?? "");
  } catch (problem) {
    note(String((problem as Error)?.message ?? "") === "attachment_open_refused" ? refused : failure);
    return false;
  }
  if (path === "") {
    note(failure);
    return false;
  }
  try {
    Backend.openDownload(path);
  } catch {
    note(failure);
    return false;
  }
  note("Opening " + name);
  return true;
}

/** A picture from the viewer, in another application ("Open in another app..."). */
async function openPicture(entry: Images.GalleryEntry): Promise<string> {
  if (entry.kind === "attachment" && entry.attachment) {
    void openAttachment(entry.attachment);
    return "Opening " + entry.name;
  }
  const payload = Images.payloadOf(entry.source);
  if (payload === "") return "That image could not be opened";
  const name = Images.filenameFor(entry);
  const opened = await storeAndOpen(name, payload, "That image could not be opened", "That image could not be opened");
  return opened ? "Opening " + name : "That image could not be opened";
}

/** A picture attachment's bytes for the viewer, prepared by the backend. */
async function attachmentImage(attachment: Images.Attachment): Promise<{ source: string; problem: "" | "download" | "large" }> {
  const at = owner();
  const id = String(attachment.attachmentId ?? "");
  try {
    const result: any = await call("attachment.image", { accountId: at.accountId, id: at.sourceId, attachmentId: id });
    const data = String(result?.data ?? "");
    if (Html.isRasterDataImage(data)) return { source: data, problem: "" };
    return { source: "", problem: "" };
  } catch (failure) {
    const reason = String((failure as Error)?.message ?? "");
    if (reason !== "attachment_image_unavailable") return { source: "", problem: "" };
  }
  if ((Number(attachment.size) || 0) > MAX_PICTURE_BYTES) return { source: "", problem: "large" };
  let data = "";
  try {
    data = await loadAttachmentData(attachment);
  } catch {
    data = "";
  }
  if (data === "") return { source: "", problem: "download" };
  if ((data.length * 3) / 4 > MAX_PICTURE_BYTES) return { source: "", problem: "large" };
  try {
    const result: any = await call("attachment.image", { data });
    const prepared = String(result?.data ?? "");
    return { source: Html.isRasterDataImage(prepared) ? prepared : "", problem: "" };
  } catch {
    return { source: "", problem: "" };
  }
}

/** Keeps a picture from the viewer: an attachment takes the attachment save. */
async function savePicture(entry: Images.GalleryEntry): Promise<string> {
  if (entry.kind === "attachment" && entry.attachment) {
    const path = await saveAttachment(entry.attachment);
    return path !== "" ? savedNote(path) : "That image could not be saved";
  }
  const payload = Images.payloadOf(entry.source);
  if (payload === "") return "That image could not be saved";
  try {
    const result: any = await call("attachment.store", { filename: Images.filenameFor(entry), data: payload, open: false });
    const path = String(result?.path ?? "");
    return path !== "" ? savedNote(path) : "That image could not be saved";
  } catch {
    return "That image could not be saved";
  }
}

// ------------------------------------------------------------------ links

/** A link in the body, a card or a notice: only mailto: and public http(s),
 * checked again here, and a web link only after the person saw where it goes. */
async function openLink(url: string, confirm: (target: string) => Promise<boolean>): Promise<void> {
  const target = Html.linkTarget(url);
  if (target === "") return;
  if (/^mailto:/i.test(target)) {
    if (parseMailto(target)) openDraft({ accountId: owner().accountId, mailto: target });
    return;
  }
  const web = Html.externallyOpenableHttpUrl(target);
  if (web === "") return;
  if (!(await confirm(web))) return;
  try {
    const result = await openUrl(web);
    if (!result.opened) note("No app could open that link");
  } catch {
    note("That link could not be opened");
  }
}

// ------------------------------------------------------------------ the address it came to

/** Which of the account's own addresses the open message arrived at
 * (MailAccount.qml receivedAsAlias): the alias an invitation names and a list
 * knows, else the account's default. */
const receivedAs = computed(() => {
  const id = openId();
  const accountId = listStore.ownerOf(id).accountId;
  const account = app.accounts().find((a) => a.id === accountId);
  const own = String(account?.email ?? "");
  const read = summaryOf();
  if (!read) return { email: own, name: "" };
  const addressed = [...((read.to as unknown[]) ?? []), ...((read.cc as unknown[]) ?? [])];
  const alias: any = preferredSendAs(composeHost().aliasesFor(accountId), addressed);
  const email = alias ? String(alias.email || "") : "";
  return { email: email !== "" ? email : own, name: alias ? String(alias.displayName || "") : "" };
});

/** Per JMAP account, what it withdrew from sending: null until its session
 * was read. Qt kept the session on the JMAP client (JmapClient.qml
 * `session`, from every jmap.* answer's state); here one `jmap.session` per
 * account and sign-in reads the backend's cached snapshot of it. */
const jmapRefusals = signal<Record<string, string | null>>({});
const sessionAsked = new Map<string, boolean>();

function askJmapSession(accountId: string, signedIn: boolean) {
  if (pinned) return;
  if (!signedIn) {
    sessionAsked.set(accountId, false);
    return;
  }
  if (sessionAsked.get(accountId) === true) return;
  sessionAsked.set(accountId, true);
  call<any>("jmap.session", { accountId, requestId: "reader-session-" + accountId }).then(
    (r) => {
      if (!untracked(() => app.accounts()).some((a) => a.id === accountId)) return;
      const refusal = Refusals.jmapSendRefusal(r?.state?.session, r?.state?.mailboxes);
      jmapRefusals.update((all) => ({ ...all, [accountId]: refusal }));
    },
    () => sessionAsked.set(accountId, false),
  );
}

/** What the account withdrew from sending, as its server said: the JMAP
 * session, or the Microsoft 365 mailbox check the accounts feature keeps (one
 * m365.verify per sign-in, `m365Check`). Null: nothing read yet. */
function sendRefusal(account: { id: string; provider: string }): string | null {
  if (account.provider === "jmap") return jmapRefusals()[account.id] ?? null;
  if (account.provider === "m365") return Refusals.m365SendRefusal(m365Check(account.id));
  return null;
}

/** Registry.can(provider, "send", refusals): every provider's ceiling sends;
 * an account may withdraw it, and a mailbox not in the window cannot. */
const canSend = computed(() => {
  const accountId = listStore.ownerOf(openId()).accountId;
  const account = app.accounts().find((a) => a.id === accountId);
  if (!account) return false;
  return Refusals.canSend(sendRefusal(account));
});

function sendFailure(provider: string, problem: unknown, unwritable: string): string {
  return problem instanceof UnwritableAddress ? unwritable : sentenceFor(clientOf(provider), problem);
}

function clientOf(provider: string): string {
  const id = String(provider || "").toLowerCase();
  return id === "outlook" ? "imap" : id === "" ? "gmail" : id;
}

// ------------------------------------------------------------------ unsubscribe

async function runUnsubscribe(confirm: (target: string) => Promise<boolean>) {
  if (untracked(() => unsubscribing()) || untracked(() => unsubscribeDone()) !== "") return;
  const info = untracked(() => unsubscribe());
  const how = Unsub.plan(info, untracked(() => canSend()));
  if (how === "") return;
  if (how === "browser") {
    const web = Html.externallyOpenableHttpUrl(info.url);
    if (web === "" || !(await confirm(web))) return;
    try {
      await openUrl(web);
      unsubscribeDone.set("The unsubscribe page is open in your browser");
    } catch {
      note("That link could not be opened");
    }
    return;
  }
  if (how === "mail") {
    // Sent on this press, as Qt sent it: the person asked to leave the list,
    // and the address is the one the list's own header named.
    if (!info.mail) return;
    const at = owner();
    const as = untracked(() => receivedAs());
    const mine = serial;
    unsubscribing.set(true);
    try {
      await sendMail(at.accountId, at.provider, {
        // The address the newsletter was sent to: a list that only knew an
        // alias has no reason to act on a request from anywhere else.
        from: as.email, fromName: as.name, accountAddress: at.email,
        to: info.mail.to, subject: info.mail.subject, body: info.mail.body,
      });
      if (mine !== serial) return;
      unsubscribing.set(false);
      unsubscribeDone.set("Unsubscribe request sent to " + info.mail.to);
    } catch (problem) {
      if (mine !== serial) return;
      unsubscribing.set(false);
      note(sendFailure(at.provider, problem, "An address in this request cannot be written into a message"));
    }
    return;
  }
  if (!Unsub.isPostableUrl(info.postUrl)) {
    note("That unsubscribe address is not one this can post to");
    return;
  }
  const mine = serial;
  unsubscribing.set(true);
  let status = 0;
  let failedCall = false;
  try {
    const result: any = await call("public.unsubscribe", { url: String(info.postUrl) });
    status = Number(result?.status ?? 0) || 0;
  } catch {
    failedCall = true;
  }
  if (mine !== serial) return;
  unsubscribing.set(false);
  if (failedCall || status === 0) {
    note("The unsubscribe request could not be sent");
    return;
  }
  if (status >= 200 && status < 300) {
    unsubscribeDone.set("Unsubscribed from this list");
    return;
  }
  note(status >= 300 && status < 400
    ? "This list answered with a redirect instead of unsubscribing (" + status + ")"
    : "This list refused the unsubscribe request (" + status + ")");
}

/** What the button says, and the sentence beside it (Unsubscribe.js). */
const unsubscribeLabel = computed(() => (unsubscribeDone() !== "" ? "" : String(Unsub.label(unsubscribe(), canSend()) || "")));
const unsubscribeDetail = computed(() => (unsubscribeDone() !== "" ? unsubscribeDone() : String(Unsub.explanation(unsubscribe(), canSend()) || "")));

// ------------------------------------------------------------------ invitations

function calendarAttendanceMethod(provider: string): string {
  return provider === "gmail" ? "calendar.attendance" : "";
}

function calendarAttendanceUrl(provider: string, accountId: string): string {
  return provider === "gmail" ? "https://calendar.google.com/calendar/u/0/r?authuser=" + encodeURIComponent(accountId) : "";
}

const ownAddress = computed(() => receivedAs().email);

const response = computed(() => (invite() ? String(Calendar.responseOf(invite(), ownAddress()) || "") : ""));
const canRespond = computed(() => !!invite() && canSend() && Calendar.canRespond(invite(), ownAddress()) === true);

function invitationParams(invited: any, accountId: string): Record<string, unknown> | null {
  const organizer = Calendar.replyRecipient(invited);
  if (!organizer) return null;
  const params: Record<string, unknown> = { accountId, uid: invited.uid, organizer };
  if (invited.recurrenceIdMs) {
    params.originalStart = new Date(invited.recurrenceIdMs).toISOString();
    const raw = String(invited.source?.recurrenceId ?? "");
    const day = /(?:^|;)VALUE=DATE(?:;[^:]*)?:(\d{4})(\d{2})(\d{2})$/.exec(raw);
    if (day) params.originalStart = day[1] + "-" + day[2] + "-" + day[3];
  }
  return params;
}

// ------------------------------------------------------------------ attendance reconcile

/** The invitation the open message carries, kept in step with Calendar where
 * the provider answers attendance itself (Rsvp.qml `reconcile`): on opening,
 * and every minute while it is on screen, the event's current fields and the
 * owner's answer come back from Calendar. Only the card changes: nothing is
 * written anywhere. */
const RECONCILE_MS = 60000;
let reconciledKey = "";
let reconciling = false;
/** Bumped by every answer and every new message, so a late read cannot undo them. */
let attendanceRevision = 0;

function reconcile() {
  const at = owner();
  const method = calendarAttendanceMethod(at.provider);
  const invited = untracked(() => invite());
  if (pinned || !method || !invited || reconciling || untracked(() => rsvpSending())) return;
  const key = at.accountId + "\n" + at.id + "\n" + String(invited.uid ?? "");
  if (key === reconciledKey) return;
  reconciledKey = key;
  const params = invitationParams(invited, at.accountId);
  if (!params) return;
  const mine = serial;
  const revision = attendanceRevision;
  const as = untracked(() => ownAddress());
  reconciling = true;
  call<any>(method, params).then(
    (result) => {
      reconciling = false;
      if (mine !== serial || revision !== attendanceRevision || untracked(() => rsvpSending()) || !result) return;
      let updated: any = { ...invited };
      if (result.cancelled) {
        updated.status = "CANCELLED";
        updated.method = "CANCEL";
      } else {
        const normalized: any[] = eventsFromGoogle({ items: [result.event] }, "");
        if (!normalized.length) return;
        const current = normalized[0];
        for (const field of ["summary", "description", "location", "start", "end", "sequence", "status", "meetLink"]) updated[field] = current[field];
        updated = Calendar.withResponse(updated, as, String(result.response || "").toUpperCase());
        if (result.response === "needsAction") {
          updated.attendees = (updated.attendees || []).map((attendee: any) =>
            String(attendee.email || "").toLowerCase() !== as.toLowerCase() ? attendee : { ...attendee, partstat: "NEEDS-ACTION" },
          );
        }
      }
      invite.set(updated);
    },
    () => {
      reconciling = false;
    },
  );
}

/** Yes / Maybe / No. Gmail answers in Calendar; elsewhere the answer is a
 * reply the person sends from compose (`mailOnly` asks for that on Gmail too). */
async function rsvp(answer: string, mailOnly = false) {
  if (untracked(() => rsvpSending()) || untracked(() => calendarSaving()) || !untracked(() => canRespond())) return;
  const at = owner();
  const invited = untracked(() => invite());
  const method = calendarAttendanceMethod(at.provider);
  if (mailOnly && !untracked(() => rsvpFallback())) return;
  if (method !== "" && !mailOnly) {
    const wanted = Calendar.normalizedResponse(answer);
    if (!wanted) return;
    const params = invitationParams(invited, at.accountId);
    if (!params) {
      note("This invitation names no organiser to answer");
      return;
    }
    attendanceRevision++;
    const mine = serial;
    rsvpSending.set(true);
    try {
      const result: any = await call(method, { ...params, response: wanted });
      if (mine !== serial) return;
      rsvpSending.set(false);
      if (!result || result.response !== wanted) throw new Error("calendar_unconfirmed");
      note("Attendance confirmed in Calendar");
      rsvpFallback.set(false);
      invite.set(Calendar.withResponse(invited, ownAddress(), answer));
    } catch (failure) {
      if (mine !== serial) return;
      rsvpSending.set(false);
      const reason = String((failure as Error)?.message ?? "");
      if (reason === "calendar_invitation_not_found" || reason === "calendar_organizer_mismatch") rsvpFallback.set(true);
      note("Calendar has not confirmed your answer. Refresh the invitation or open it in Calendar.");
    }
    return;
  }
  // The alias the invitation was addressed to: the ATTENDEE line has to name
  // the person who was invited, and the envelope has to agree with it.
  const as = untracked(() => receivedAs());
  const fields: any = Calendar.replyFields(invited, { email: as.email, name: as.name }, answer);
  if (!fields) {
    note("This invitation names no organiser to answer");
    return;
  }
  const summary = untracked(() => summaryOf());
  const target = untracked(() => invitationDestination());
  const mine = serial;
  rsvpSending.set(true);
  calendarDone.set(false);
  try {
    await sendMail(at.accountId, at.provider, {
      from: as.email, fromName: as.name, accountAddress: at.email,
      to: String(fields.to ?? ""), subject: String(fields.subject ?? ""), body: String(fields.body ?? ""),
      calendar: fields.calendar ?? null,
      // Threaded with the invitation it answers, as a calendar's own reply is.
      inReplyTo: String(summary?.messageId ?? ""), threadId: String(summary?.threadId ?? ""),
    });
  } catch (problem) {
    if (mine !== serial) return;
    rsvpSending.set(false);
    note(sendFailure(at.provider, problem, "An address in this answer cannot be written into a message"));
    return;
  }
  if (mine !== serial) return;
  rsvpSending.set(false);
  note(mailOnly ? "Reply email sent; Calendar attendance is not confirmed" : "Answer sent to " + String(fields.to ?? ""));
  if (mailOnly) return;
  invite.set(Calendar.withResponse(invited, as.email, answer));
  if (target) void saveToCalendar(target, at.accountId, invited, String(Calendar.normalizedResponse(answer) || ""));
}

// ------------------------------------------------------------------ the saved calendar copy

/** The calendar this mailbox saves accepted invitations to (Settings), for a
 * provider whose calendar does not answer for itself. */
const invitationDestination = computed<any>(() => {
  const accountId = listStore.ownerOf(openId()).accountId;
  const account = app.accounts().find((a) => a.id === accountId);
  if (!account || calendarAttendanceMethod(account.provider) !== "") return null;
  return Invitations.destination(calendarSettings.value(), accountId);
});

async function saveToCalendar(target: any, accountId: string, invited: any, answer: string) {
  if (untracked(() => calendarSaving())) return;
  const params: any = Invitations.params(target, accountId, invited, answer);
  if (!params) {
    calendarMessage.set("Not saved: the invitation has incomplete dates or an unresolved time zone");
    return;
  }
  const mine = serial;
  calendarSaving.set(true);
  calendarMessage.set("Saving to calendar…");
  let result: any = null;
  let problem: any = null;
  try {
    result = await call("calendar.saveInvitation", params);
  } catch (failure) {
    problem = failure;
  }
  calendarSaving.set(false);
  const current = untracked(() => invite());
  if (mine !== serial || !current || current.uid !== invited.uid
    || Number(current.sequence || 0) !== Number(invited.sequence || 0)) return;
  const ok = !problem && !!result;
  calendarDone.set(ok);
  const text = ok ? String(Invitations.outcome(result.status)) : String(Invitations.failure(problem, 10));
  calendarMessage.set(text);
  if (!ok) note(text.split("\n")[0]);
}

/** "Save / update calendar": saves the answer already given again. */
function retryCalendar() {
  const state = untracked(() => calendarState());
  if (!state.canSave) return;
  const invited = untracked(() => invite());
  const response = invited.method === "CANCEL" || invited.status === "CANCELLED" ? "cancelled"
    : String(Calendar.normalizedResponse(Calendar.responseOf(invited, untracked(() => ownAddress()))) || "");
  void saveToCalendar(untracked(() => invitationDestination()), owner().accountId, invited, response);
}

/** The card's line about the saved copy (Rsvp.qml calendarState). */
const calendarState = computed(() => {
  const target = invitationDestination();
  const invited = invite();
  const answered = !!invited && (String(Calendar.normalizedResponse(Calendar.responseOf(invited, ownAddress())) || "") !== ""
    || invited.method === "CANCEL" || invited.status === "CANCELLED");
  return {
    visible: !!target && !!invited,
    busy: calendarSaving(),
    text: calendarMessage() || "Accepted invitations → " + String(target?.name || "Google Calendar"),
    canSave: !!target && !calendarSaving() && !calendarDone() && !rsvpSending() && !!invited && answered,
  };
});

// ------------------------------------------------------------------ answering

/** Reply, reply all or forward the open message, or reopen it as a draft. */
function composeFrom(mode: "reply" | "replyAll" | "forward" | "draft") {
  const at = owner();
  if (at.id === "" || at.accountId === "") return;
  if (mode === "draft") {
    openDraft({ accountId: at.accountId, draftId: at.sourceId });
    return;
  }
  openDraft({
    accountId: at.accountId,
    replyTo: {
      accountId: at.accountId, messageId: at.sourceId, mode,
      summary: untracked(() => summaryOf()), body: untracked(() => body()).text,
      attachments: untracked(() => attachments()),
    },
  });
}

// ------------------------------------------------------------------ derived

const offer = computed<Html.BodyOffer>(() => {
  const ready = render();
  return {
    html: hasHtml(),
    reader: !!ready?.reader?.document && ready.reader.empty !== true,
    readerHeavy: ready?.reader?.tooHeavy === true,
    originalHeavy: ready?.tooHeavy === true,
    forced: forceRich(),
  };
});

const shownMode = computed<Html.BodyMode>(() => Html.resolveBodyMode(readerPrefs.bodyMode(), offer()));

/** The pictures drawn in the body on screen, numbered as its links number them. */
const shownImages = computed<string[]>(() => {
  const ready = render();
  const mode = shownMode();
  if (mode === "reader") return Html.documentImages(ready?.reader?.document ?? null);
  if (mode === "original") return Html.documentImages(ready?.document ?? null);
  return plainImages();
});

/** The blocked pictures of the body actually on screen. */
const blockedCount = computed(() => {
  const ready = render();
  if (!ready) return 0;
  return shownMode() === "reader" ? ready.reader?.blockedImages ?? 0 : ready.remoteImages;
});

const canOpenOnWeb = computed(() => {
  const id = openId();
  const accountId = listStore.ownerOf(id).accountId;
  const account = app.accounts().find((a) => a.id === accountId);
  return !!account && capabilitiesOf(account.provider).web;
});

// ------------------------------------------------------------------ wiring

let started = false;
/** Set by `previewMessage`: the selection no longer drives the reader. */
let pinned = false;

/** Follows the open message; called once by the reader's root. */
export function useReader() {
  if (started) return;
  started = true;
  void readerPrefs.load();
  effect(() => {
    const id = app.selectedId();
    untracked(() => {
      if (!pinned && id !== openId()) open(id);
    });
  });
  // A new message starts its own reconcile; the invitation arriving (or
  // changing) asks Calendar, and a minute on screen asks again.
  effect(() => {
    openId();
    untracked(() => {
      reconciledKey = "";
      attendanceRevision++;
    });
  });
  effect(() => {
    if (!invite()) return;
    untracked(() => {
      calendarDone.set(false);
      queueMicrotask(reconcile);
    });
  });
  effect(() => {
    const id = openId();
    if (!invite() || !app.accounts().some((a) => a.id === listStore.ownerOf(id).accountId)) return;
    const timer = setInterval(() => {
      reconciledKey = "";
      reconcile();
    }, RECONCILE_MS);
    cleanup(() => clearInterval(timer));
  });
  // The open message's account says whether it sends, once per sign-in.
  effect(() => {
    const accountId = listStore.ownerOf(openId()).accountId;
    const account = app.accounts().find((a) => a.id === accountId);
    if (!account) return;
    const signedIn = account.signedIn !== false;
    if (account.provider === "jmap") untracked(() => askJmapSession(account.id, signedIn));
  });
  // The standing answer changed in Settings (or here): the open message follows.
  let wasAlways = untracked(() => readerPrefs.alwaysShowImages());
  effect(() => {
    const always = readerPrefs.alwaysShowImages();
    untracked(() => {
      if (always === wasAlways) return;
      wasAlways = always;
      if (openId() === "") return;
      if (always) showMessageImages();
      else if (remoteAllowed()) {
        stopImages();
        batch(() => {
          remoteAllowed.set(false);
          remoteData.set({});
          remoteLoading.set(false);
        });
        renderSource();
      }
    });
  });
}

/** Shows `resource` (a `reader.open` answer) as message `id` without asking
 * the backend: the screenshot fixtures, which run with no backend at all. */
export function previewMessage(id: string, resource: any) {
  pinned = true;
  serial++;
  live = false;
  markedRead = true;
  openId.set(id);
  reset();
  apply(resource, false, false, serial);
}

export const reader = {
  id: () => openId(),
  summary: summaryOf,
  loading: () => loading(),
  painted: () => painted(),
  error: () => error(),
  hasHtml: () => hasHtml(),
  render: () => render(),
  body: () => body(),
  attachments: () => attachments(),
  shownMode,
  shownImages,
  plainImages: () => plainImages(),
  offer,
  tooHeavy: computed(() => Html.bodyModeRefused(readerPrefs.bodyMode(), offer())),
  readingEmpty: computed(() => Html.bodyModeEmptied(readerPrefs.bodyMode(), offer())),
  blockedCount,
  remoteAllowed: () => remoteAllowed(),
  remoteLoading: () => remoteLoading(),
  canOpenOnWeb,
  forceRich: () => forceRich.set(true),
  // Pictures
  showMessageImages,
  alwaysShowImages,
  displayImage,
  attachmentImage,
  savePicture,
  // Attachments
  saving: (id: string) => saving()[id] === true,
  saveAttachment,
  openAttachment,
  openPicture,
  // Links
  openLink,
  // Unsubscribe
  unsubscribeLabel,
  unsubscribeDetail,
  unsubscribing: () => unsubscribing(),
  runUnsubscribe,
  // Invitation
  invite: () => invite(),
  response,
  canRespond,
  rsvpSending: () => rsvpSending(),
  rsvpFallback: computed(() => rsvpFallback() && canRespond()),
  calendarUrl: computed(() => {
    const accountId = listStore.ownerOf(openId()).accountId;
    const account = app.accounts().find((a) => a.id === accountId);
    return account ? calendarAttendanceUrl(account.provider, accountId) : "";
  }),
  rsvp,
  calendarState,
  retryCalendar,
  canSend,
  compose: composeFrom,
  // What the assistant found in the message (the assistant feature sets them).
  /** The open message's account and the id its provider uses. */
  owner: computed(() => listStore.ownerOf(openId())),
  /** The body as plain text (what an AI look reads beside the subject). */
  bodyText: () => body().text,
  /** The message came from a mailing list (it offers an unsubscribe). */
  listMail: computed(() => unsubscribe().available === true),
  /** A line on the window's status (MailAccount.fail). */
  notice: (text: string) => note(text),
  suggestions: () => suggestions(),
  setSuggestions(list: EventSuggestion[]) {
    suggestions.set(Array.isArray(list) ? list.slice() : []);
  },
  onAddSuggestion: null as ((suggestion: EventSuggestion) => void) | null,
  onDismissSuggestion: null as ((key: string) => void) | null,
  /** Reopens the message (the error's Try again). */
  retry() {
    const id = untracked(() => openId());
    openId.set("");
    open(id);
  },
};
