// The message list's rules, as pure functions. Port of the list parts of
// omarchy/ui/account/Model.js and Conversation.js: cursor movement, checking
// and ranges, which verb a key asks for, what survives an action, the notes an
// action leaves, new-mail arrivals and reload depth. Nothing here touches the
// backend or the screen, so every rule is tested on its own (listModel.test.ts).

export interface Address {
  name?: string;
  email?: string;
  display?: string;
}

/** The conversation a row stands for (`Message.normalizeThread`). */
export interface ThreadBlock {
  id: string;
  count: number;
  unread: boolean;
  flagged: boolean;
  memberIds: string[];
}

/** One row, as `message.summaries` answers it, hydrated with a Date. */
export interface Summary {
  id: string;
  threadId?: string;
  from?: Address | null;
  subject: string;
  snippet: string;
  date: Date | null;
  dateMs?: number;
  time: string;
  unread: boolean;
  starred: boolean;
  inInbox?: boolean;
  inTrash?: boolean;
  inSpam?: boolean;
  isSent?: boolean;
  isDraft?: boolean;
  labelIds?: string[];
  thread?: ThreadBlock | null;
  /** Content direction of the subject, when the backend resolved one. */
  direction?: string;
  /** Unified rows: the owning account, its own id and the mailbox label drawn. */
  accountId?: string;
  sourceId?: string;
  sourceLabel?: string;
  [extra: string]: unknown;
}

/** Where the list is looking, for the rules that depend on it. */
export interface ListView {
  mailboxKey: string;
  searchQuery: string;
  rawQuery: string;
  /** Whether the provider has a spam verb (an IMAP Junk message is archived). */
  canReportSpam?: boolean;
  /** In a unified view, the spam verb of the mailbox that owns a row. */
  canReportSpamFor?: (id: string) => boolean;
}

export const MINIMUM_MEMBERS = 2;

// ------------------------------------------------------------ conversation

export function blockOf(value: unknown): ThreadBlock | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Partial<ThreadBlock>;
  const list = Array.isArray(source.memberIds) ? source.memberIds : [];
  const ids: string[] = [];
  for (const item of list) {
    const id = String(item ?? "").trim();
    if (id !== "") ids.push(id);
  }
  return {
    id: String(source.id ?? "").trim(),
    count: ids.length,
    unread: source.unread === true,
    flagged: source.flagged === true,
    memberIds: ids,
  };
}

/** The number a row's badge shows: the conversation's length, or 0. */
export function badgeCount(summary: Summary | null | undefined): number {
  const block = blockOf(summary?.thread);
  return block && block.count >= MINIMUM_MEMBERS ? block.count : 0;
}

const CONVERSATION_ACTIONS = ["archive", "unarchive", "trash", "untrash", "spam", "markRead", "markUnread", "unstar"];

export function actionScope(action: string): "conversation" | "message" {
  return CONVERSATION_ACTIONS.includes(String(action ?? "")) ? "conversation" : "message";
}

/** The ids an action on a row is sent for: a conversation's members for a
 * conversation verb, else the row itself. */
export function actionTargets(row: Summary | null | undefined, action: string): string[] {
  const id = row && row.id != null ? String(row.id) : "";
  const own = id === "" ? [] : [id];
  if (actionScope(action) !== "conversation") return own;
  const block = blockOf(row?.thread);
  if (!block || block.count === 0) return own;
  return block.memberIds.slice();
}

// ------------------------------------------------------------ lookups

export function indexById(list: readonly { id: string }[] | null | undefined, id: string): number {
  const source = Array.isArray(list) ? list : [];
  for (let i = 0; i < source.length; i++) if (source[i] && source[i].id === id) return i;
  return -1;
}

export function allIds(list: readonly { id: string }[] | null | undefined): string[] {
  return (Array.isArray(list) ? list : []).map((row) => row.id);
}

export function summariesById<T extends { id: string }>(list: readonly T[], ids: readonly string[]): T[] {
  const out: T[] = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    const at = indexById(list, id);
    if (at >= 0) out.push(list[at]);
  }
  return out;
}

// ------------------------------------------------------------ cursor

/** Where the cursor lands after a step, anchored on the cursor itself; with
 * none (or one that left), j starts at the top and k at the bottom. */
export function cursorAfterOffset(list: readonly { id: string }[], cursorId: string, delta: number): string {
  const source = Array.isArray(list) ? list : [];
  if (source.length === 0) return "";
  const step = Math.floor(Number(delta) || 0);
  const index = indexById(source, cursorId);
  if (index < 0) return step < 0 ? source[source.length - 1].id : source[0].id;
  const next = Math.max(0, Math.min(source.length - 1, index + step));
  return source[next].id;
}

/** Where the cursor goes when its row is about to leave: the row below, else
 * above. Asked of the list as it still is. */
export function cursorAfterRemoval(list: readonly { id: string }[], cursorId: string): string {
  const index = indexById(list, cursorId);
  if (index < 0) return "";
  if (index + 1 < list.length) return list[index + 1].id;
  if (index > 0) return list[index - 1].id;
  return "";
}

/** Several rows leaving at once: the first survivor after the cursor, or the
 * last one before it. */
export function cursorAfterRemovals(list: readonly { id: string }[], removedIds: readonly string[], cursorId: string): string {
  const index = indexById(list, cursorId);
  if (index < 0) return "";
  const gone = Array.isArray(removedIds) ? removedIds : [];
  for (let i = index; i < list.length; i++) if (!gone.includes(list[i].id)) return list[i].id;
  for (let i = index - 1; i >= 0; i--) if (!gone.includes(list[i].id)) return list[i].id;
  return "";
}

/** The whole list replaced under the cursor: it stays if its row survived,
 * else the top. */
export function cursorAfterReload(list: readonly { id: string }[], cursorId: string): string {
  if (!Array.isArray(list) || list.length === 0) return "";
  if (indexById(list, cursorId) >= 0) return cursorId;
  return list[0].id;
}

/** The scroll offset that reveals a row with the least movement: unchanged
 * while it is already visible; a row taller than the view shows its top. */
export function contentYToReveal(contentY: number, viewportHeight: number, itemY: number, itemHeight: number,
  contentHeight: number, margin = 0): number {
  const top = Number(contentY) || 0;
  const view = Number(viewportHeight) || 0;
  const y = Number(itemY) || 0;
  const height = Number(itemHeight) || 0;
  const pad = Number(margin) || 0;
  let next = top;
  if (height + pad + pad > view) next = y - pad;
  else if (y - pad < top) next = y - pad;
  else if (y + height + pad > top + view) next = y + height + pad - view;
  const max = Math.max(0, (Number(contentHeight) || 0) - view);
  return Math.max(0, Math.min(max, next));
}

// ------------------------------------------------------------ checking

export function toggleId(ids: readonly string[], id: string): string[] {
  const list = Array.isArray(ids) ? ids.slice() : [];
  const key = String(id ?? "");
  if (key === "") return list;
  const at = list.indexOf(key);
  if (at >= 0) list.splice(at, 1);
  else list.push(key);
  return list;
}

/** Every id from one row to another, inclusive, in list order. */
export function idsBetween(list: readonly { id: string }[], fromId: string, toId: string): string[] {
  let a = indexById(list, fromId);
  let b = indexById(list, toId);
  if (a < 0 && b < 0) return [];
  if (a < 0) a = b;
  if (b < 0) b = a;
  const out: string[] = [];
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.push(list[i].id);
  return out;
}

export function unionIds(ids: readonly string[], more: readonly string[]): string[] {
  const out = Array.isArray(ids) ? ids.slice() : [];
  for (const id of Array.isArray(more) ? more : []) if (!out.includes(id)) out.push(id);
  return out;
}

/** Shift-click: the clicked row's next checked state applied to the inclusive
 * range from the cursor; rows outside it are left as they were. */
export function toggleRange(ids: readonly string[], list: readonly { id: string }[], fromId: string, toId: string): string[] {
  const checked = Array.isArray(ids) ? ids : [];
  if (indexById(list, toId) < 0) return checked.slice();
  const range = idsBetween(list, fromId, toId);
  if (!checked.includes(toId)) return unionIds(checked, range);
  return checked.filter((id) => !range.includes(id));
}

/** The checked ids still listed. */
export function retainIds(ids: readonly string[], list: readonly { id: string }[]): string[] {
  return (Array.isArray(ids) ? ids : []).filter((id) => indexById(list, id) >= 0);
}

/** Ctrl+A: every loaded row, or none when every one is already checked. */
export function checkAllToggle(ids: readonly string[], list: readonly { id: string }[]): string[] {
  const every = allIds(list);
  const all = every.length > 0 && every.every((id) => ids.includes(id));
  return all ? [] : every;
}

/** The rows an action on `id` reaches: every checked row when the row is one
 * of them, else the row alone. */
export function reachedIds(checked: readonly string[], id: string): string[] {
  const list = Array.isArray(checked) ? checked : [];
  if (id !== "" && list.includes(id)) return list.slice();
  return id === "" ? [] : [id];
}

export function selectionStatus(count: number): string {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  return n === 0 ? "" : n + " selected";
}

// ------------------------------------------------------------ verbs

export const MOVE_PREFIX = "label:";
const SYSTEM_LABEL_IDS = ["INBOX", "UNREAD", "STARRED", "IMPORTANT", "SENT", "DRAFT", "TRASH", "SPAM", "CHAT"];

export function isSystemLabelId(id: string): boolean {
  const value = String(id ?? "");
  return SYSTEM_LABEL_IDS.includes(value) || value.startsWith("CATEGORY_");
}

export function labelTarget(action: string): string {
  const verb = String(action ?? "");
  return verb.startsWith(MOVE_PREFIX) ? verb.slice(MOVE_PREFIX.length) : "";
}

export interface LabelChange { add: string[]; remove: string[] }

export function labelChangesFor(action: string, sourceLabelId = ""): LabelChange | null {
  if (action === "markRead") return { add: [], remove: ["UNREAD"] };
  if (action === "markUnread") return { add: ["UNREAD"], remove: [] };
  if (action === "star") return { add: ["STARRED"], remove: [] };
  if (action === "unstar") return { add: [], remove: ["STARRED"] };
  if (action === "archive") return { add: [], remove: ["INBOX"] };
  if (action === "unarchive") {
    const filed = String(sourceLabelId ?? "");
    if (filed === "" || isSystemLabelId(filed)) return { add: ["INBOX"], remove: [] };
    return { add: ["INBOX"], remove: [filed] };
  }
  if (action === "spam") return { add: ["SPAM"], remove: ["INBOX"] };
  const target = labelTarget(action);
  if (target !== "") {
    const remove = ["INBOX"];
    const source = String(sourceLabelId ?? "");
    if (source !== "" && source !== target && !remove.includes(source)) remove.push(source);
    return { add: [target], remove };
  }
  return null;
}

/** Whether a row stays in the view after the action (Model.survivesAction). */
export function survivesAction(mailboxKey: string, action: string, rawQuery: string, labels: boolean,
  sourceLabelId: string, row?: Summary | null): boolean {
  const key = String(mailboxKey || "inbox");
  const verb = String(action ?? "");
  const block = blockOf(row?.thread);
  if (block && block.count > 0) {
    if (verb === "markRead" && key === "unread") return block.unread;
    if (verb === "unstar" && key === "starred") return block.flagged;
  }
  if (verb === "trash") return key === "trash";
  if (verb === "untrash") return key !== "trash";
  if (verb === "spam") return key === "spam";
  if (verb === "unarchive") {
    if (labels !== true) return false;
    if (String(rawQuery ?? "") === "") return true;
    const filed = String(sourceLabelId ?? "");
    if (filed === "") return false;
    return (labelChangesFor("unarchive", filed)?.remove.length ?? 0) === 0;
  }
  if (labelTarget(verb) !== "" && String(rawQuery ?? "") !== "") return false;
  if (verb === "archive" || labelTarget(verb) !== "") return key !== "inbox" && key !== "unread";
  if (verb === "markRead") return key !== "unread";
  if (verb === "unstar") return key !== "starred";
  return true;
}

/** The row as the action leaves it, for the optimistic edit. */
export function rowAfterAction(row: Summary, action: string, sourceLabelId = ""): Summary {
  const change = labelChangesFor(action, sourceLabelId);
  const next: Summary = { ...row };
  let labels = Array.isArray(row.labelIds) ? row.labelIds.slice() : [];
  if (change) {
    labels = labels.filter((label) => !change.remove.includes(label));
    for (const label of change.add) if (!labels.includes(label)) labels.push(label);
    next.labelIds = labels;
  }
  if (action === "markRead") next.unread = false;
  if (action === "markUnread") next.unread = true;
  if (action === "star") next.starred = true;
  if (action === "unstar") next.starred = false;
  if (action === "archive" || labelTarget(action) !== "") next.inInbox = false;
  if (action === "unarchive") next.inInbox = true;
  if (action === "spam") { next.inSpam = true; next.inInbox = false; }
  if (action === "trash") next.inTrash = true;
  if (action === "untrash") next.inTrash = false;
  const block = blockOf(row.thread);
  if (block && actionScope(action) === "conversation") {
    if (action === "markRead") block.unread = false;
    if (action === "markUnread") block.unread = true;
    if (action === "unstar") block.flagged = false;
    next.thread = block;
  }
  return next;
}

export function actionCapability(action: string): string {
  const verb = String(action ?? "");
  if (verb === "archive" || verb === "unarchive") return "archive";
  if (verb === "star" || verb === "unstar") return "star";
  if (verb === "spam") return "spam";
  if (labelTarget(verb) !== "") return "move";
  return "";
}

export function actionUnavailable(action: string, providerName: string): string {
  const name = String(providerName || "This mailbox");
  const needs = actionCapability(action);
  if (needs === "archive") return name + " has no archive";
  if (needs === "star") return name + " has no star";
  if (needs === "spam") return name + " has no junk verb to report to";
  if (needs === "move") return name + " has no destination you can name";
  return "";
}

export function plainMailbox(view: ListView | null | undefined): string {
  const on = view ?? { mailboxKey: "", searchQuery: "", rawQuery: "" };
  if (String(on.searchQuery ?? "") !== "" || String(on.rawQuery ?? "") !== "") return "";
  return String(on.mailboxKey ?? "");
}

export function inTrash(summary: Summary | null | undefined, view: ListView | null | undefined): boolean {
  if (!summary) return false;
  return summary.inTrash === true || plainMailbox(view) === "trash";
}

export function isArchived(summary: Summary | null | undefined, view: ListView | null | undefined): boolean {
  if (!summary || summary.inInbox !== false || inTrash(summary, view)) return false;
  if (summary.isSent === true || summary.isDraft === true) return false;
  if (summary.inSpam !== true) return true;
  const canSpam = view?.canReportSpamFor ? view.canReportSpamFor(summary.id) : view?.canReportSpam;
  return canSpam === false;
}

export function allInTrash(rows: readonly Summary[], view: ListView | null | undefined): boolean {
  return Array.isArray(rows) && rows.length > 0 && rows.every((row) => inTrash(row, view));
}

export function allArchived(rows: readonly Summary[], view: ListView | null | undefined): boolean {
  return Array.isArray(rows) && rows.length > 0 && rows.every((row) => isArchived(row, view));
}

/** What the archive or trash slot asks for: the way back where its action is
 * already done for every row it reaches (`d` restores in the trash, `e`
 * moves archived mail to the Inbox in Archive). */
export function keyActionFor(action: string, rows: readonly Summary[], view: ListView | null | undefined): string {
  const verb = String(action ?? "");
  if (verb === "trash") return allInTrash(rows, view) ? "untrash" : verb;
  if (verb === "archive" && plainMailbox(view) === "archive" && allArchived(rows, view)) return "unarchive";
  return verb;
}

/** One star key over several rows: all starred means unstar, else star. */
export function starActionFor(rows: readonly (Summary | null)[]): "star" | "unstar" {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return "star";
  return list.every((row) => row && row.starred) ? "unstar" : "star";
}

/** The words for the four slot verbs, so a verb reads the same everywhere. */
export function actionName(action: string, labelView = false): string {
  const verb = String(action ?? "");
  if (verb === "archive") return "Archive";
  if (verb === "trash") return "Move to trash";
  if (verb === "untrash") return "Restore";
  if (verb === "unarchive") return labelView ? "Move to Inbox and remove label" : "Move to Inbox";
  return "";
}

/** The note an action leaves (MailAccount.actionLabel). */
export function actionLabel(action: string, labelName?: (id: string) => string): string {
  switch (action) {
    case "archive": return "Archived";
    case "trash": return "Moved to trash";
    case "untrash": return "Restored";
    case "star": return "Starred";
    case "unstar": return "Unstarred";
    case "markRead": return "Marked read";
    case "markUnread": return "Marked unread";
    case "unarchive": return "Moved to Inbox";
    case "spam": return "Reported as spam";
  }
  const target = labelTarget(action);
  if (target !== "") return "Moved to " + (labelName ? labelName(target) : target);
  return "Done";
}

/** The verb that undoes an action, or "" where there is none to offer. */
export function inverseAction(action: string): string {
  switch (action) {
    case "archive": return "unarchive";
    case "unarchive": return "archive";
    case "trash": return "untrash";
    case "untrash": return "trash";
    case "star": return "unstar";
    case "unstar": return "star";
    case "markRead": return "markUnread";
    case "markUnread": return "markRead";
  }
  return "";
}

// ------------------------------------------------------------ notes

export function pluralize(count: number, singular: string, plural?: string): string {
  const value = Math.max(0, Math.floor(Number(count) || 0));
  return value + " " + (value === 1 ? singular : (plural || singular + "s"));
}

/** "3 messages archived". */
export function batchNote(count: number, label: string): string {
  const text = String(label ?? "");
  if (text === "") return pluralize(count, "message");
  return pluralize(count, "message") + " " + text.charAt(0).toLowerCase() + text.slice(1);
}

/** "2 of 5 could not be moved to trash: <reason>". */
export function batchFailureNote(asked: number, failed: number, label: string, error: string): string {
  const text = String(label ?? "");
  const verb = text === "" ? "acted on" : text.charAt(0).toLowerCase() + text.slice(1);
  const reason = String(error ?? "").trim();
  return failed + " of " + asked + " could not be " + verb + (reason === "" ? "" : ": " + reason);
}

export function markAllReadNote(rows: number, expanded: boolean): string {
  return pluralize(rows, expanded ? "conversation" : "message") + " marked read";
}

export function listNoun(list: readonly Summary[]): "conversation" | "message" {
  return (Array.isArray(list) ? list : []).some((row) => badgeCount(row) > 0) ? "conversation" : "message";
}

export function resultSummary(list: readonly Summary[], estimate: number, hasMore: boolean): string {
  const shown = Array.isArray(list) ? list.length : 0;
  if (shown === 0) return "No messages";
  const noun = listNoun(list);
  if (!hasMore) return pluralize(shown, noun);
  const total = Math.floor(Number(estimate) || 0);
  if (total <= shown) return pluralize(shown, noun) + " so far";
  return shown + " of about " + total;
}

// ------------------------------------------------------------ list states

export function showInitialListSkeleton(loading: boolean, messageCount: number): boolean {
  return !!loading && Math.max(0, Number(messageCount) || 0) === 0;
}

export function showListFooter(messageCount: number): boolean {
  return Math.max(0, Number(messageCount) || 0) > 0;
}

export const RELOAD_CEILING = 100;

/** How many rows a reload asks for: as deep as the view had paged, bounded. */
export function reloadLimit(pageSize: number, loadedDepth: number): number {
  const page = Math.max(1, Math.floor(Number(pageSize)) || 1);
  const depth = Math.floor(Number(loadedDepth)) || 0;
  if (depth <= page) return page;
  return Math.min(Math.max(page, RELOAD_CEILING), depth);
}

/** The rows whose request failed, put back where they were. */
export function restoreRows<T extends { id: string }>(current: readonly T[], before: readonly T[], failedIds: readonly string[]): T[] {
  const now = Array.isArray(current) ? current.slice() : [];
  const was = Array.isArray(before) ? before : [];
  const ids = Array.isArray(failedIds) ? failedIds : [];
  for (let i = 0; i < was.length; i++) {
    const row = was[i];
    if (!row || !ids.includes(String(row.id))) continue;
    const at = indexById(now, row.id);
    if (at >= 0) { now[at] = row; continue; }
    let insertAt = now.length;
    for (let j = i + 1; j < was.length; j++) {
      const later = indexById(now, was[j].id);
      if (later >= 0) { insertAt = later; break; }
    }
    now.splice(insertAt, 0, row);
  }
  return now;
}

function sameValue(left: unknown, right: unknown, depth: number): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  if (depth <= 0) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    const r = right as unknown[];
    if (left.length !== r.length) return false;
    return left.every((item, i) => sameValue(item, r[i], depth - 1));
  }
  const l = left as Record<string, unknown>;
  const r = right as Record<string, unknown>;
  for (const key of Object.keys(l)) if (!sameValue(l[key], r[key], depth - 1)) return false;
  for (const key of Object.keys(r)) if (!(key in l) && r[key] !== undefined) return false;
  return true;
}

/** Whether a list says what the list on screen says, row by row and field by
 * field (rows arrive rebuilt, so identity says nothing). */
export function sameSummaries(previous: readonly Summary[], next: readonly Summary[]): boolean {
  const before = Array.isArray(previous) ? previous : [];
  const after = Array.isArray(next) ? next : [];
  if (before === after) return true;
  if (before.length !== after.length) return false;
  return after.every((row, i) => sameValue(before[i], row, 4));
}

// ------------------------------------------------------------ arrivals

export function newestDate(summaries: readonly Summary[]): number {
  let newest = 0;
  for (const summary of Array.isArray(summaries) ? summaries : []) {
    const time = summary?.date instanceof Date ? summary.date.getTime() : NaN;
    if (isFinite(time) && time > newest) newest = time;
  }
  return newest;
}

/** Only unread Inbox rows never seen before, and not older than the floor the
 * mailbox reported when notifications were primed. */
export function newArrivals(summaries: readonly Summary[], seenIds: Record<string, boolean>, primed: boolean, floorMs: number): Summary[] {
  if (!primed) return [];
  const seen = seenIds ?? {};
  const floor = typeof floorMs === "number" && isFinite(floorMs) && floorMs > 0 ? floorMs : 0;
  const out: Summary[] = [];
  for (const summary of Array.isArray(summaries) ? summaries : []) {
    if (!summary || !summary.unread || !summary.inInbox) continue;
    if (seen[summary.id]) continue;
    if (floor > 0 && summary.date instanceof Date) {
      const time = summary.date.getTime();
      if (isFinite(time) && time < floor) continue;
    }
    out.push(summary);
  }
  return out;
}

export function notificationTitle(summary: Summary | null | undefined): string {
  const title = summary?.from ? String(summary.from.display ?? summary.from.name ?? summary.from.email ?? "") : "";
  return title === "" ? "New message" : title;
}

export function notificationBody(summary: Summary | null | undefined): string {
  if (!summary) return "";
  const subject = String(summary.subject ?? "").trim();
  const snippet = String(summary.snippet ?? "").trim();
  if (!snippet) return subject;
  return subject + "\n" + (snippet.length > 140 ? snippet.substring(0, 139) + "…" : snippet);
}

/** One notification per batch (NewMailNotification.qml). */
export function arrivalNotice(arrivals: readonly Summary[]): { title: string; body: string } | null {
  const list = Array.isArray(arrivals) ? arrivals : [];
  if (list.length === 0) return null;
  if (list.length === 1) return { title: notificationTitle(list[0]), body: notificationBody(list[0]) };
  const titles = list.slice(0, 3).map((row) => notificationTitle(row));
  return { title: pluralize(list.length, "new message"), body: titles.join(", ") };
}

// ------------------------------------------------------------ time

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => (n < 10 ? "0" : "") + n;

/** A row's short time (Message.relativeTime): now, 5m, 14:02, Tue, Mar 4, Mar 4, 2024. */
export function relativeTime(date: Date | null, now: Date): string {
  if (!date || !isFinite(date.getTime())) return "";
  const elapsed = Math.max(0, now.getTime() - date.getTime());
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return minutes + "m";
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  if (sameDay) return pad(date.getHours()) + ":" + pad(date.getMinutes());
  const days = Math.floor(elapsed / 86400000);
  if (days < 3) return WEEKDAYS[date.getDay()];
  if (days < 365) return MONTHS[date.getMonth()] + " " + date.getDate();
  return MONTHS[date.getMonth()] + " " + date.getDate() + ", " + date.getFullYear();
}

export function fullTime(date: Date | null): string {
  if (!date || !isFinite(date.getTime())) return "";
  return MONTHS[date.getMonth()] + " " + date.getDate() + ", " + date.getFullYear()
    + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
}

/** A summary from the backend, with its date made a Date and its time read. */
export function hydrateSummary(raw: Record<string, unknown>, now: Date = new Date()): Summary {
  const summary = { ...raw } as Summary;
  const stamp = raw.dateMs ?? raw.date ?? 0;
  const date = stamp instanceof Date ? stamp : new Date(typeof stamp === "number" ? stamp : String(stamp));
  summary.date = isFinite(date.getTime()) && date.getTime() > 0 ? date : null;
  summary.time = relativeTime(summary.date, now);
  summary.subject = String(raw.subject ?? "") || "(no subject)";
  summary.snippet = String(raw.snippet ?? "");
  summary.unread = raw.unread === true;
  summary.starred = raw.starred === true;
  summary.thread = raw.thread ? blockOf(raw.thread) : null;
  return summary;
}

/** The sender as a row draws it. */
export function senderText(summary: Summary | null | undefined): string {
  const from = summary?.from;
  if (!from) return "";
  return String(from.display || from.name || from.email || "");
}
