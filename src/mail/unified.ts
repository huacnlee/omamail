// One list out of several mailboxes. Port of omarchy/ui/account/Unified.js:
// composed row ids (account + U+001F + the provider's id), the newest-first
// merge cut at the shallowest page's watermark so no hole shows, batching a
// selection per account, and the "all of them" answers for loading, errors
// and capabilities. Pure and tested (unified.test.ts).
import type { Summary, ThreadBlock } from "./listModel";

/** A control character no provider id can hold (IMAP forbids it in a folder
 * name, Gmail issues hex, HEY `<posting>:<topic>`). */
export const ID_SEPARATOR = "\u001f";

export function unifiedId(accountId: string, messageId: string): string {
  const account = String(accountId ?? "");
  const id = String(messageId ?? "");
  if (account === "" || id === "") return "";
  return account + ID_SEPARATOR + id;
}

export function splitUnifiedId(value: string): { accountId: string; id: string } {
  const text = String(value ?? "");
  const at = text.indexOf(ID_SEPARATOR);
  if (at <= 0) return { accountId: "", id: "" };
  return { accountId: text.substring(0, at), id: text.substring(at + 1) };
}

export function accountOf(id: string): string {
  return splitUnifiedId(id).accountId;
}

export function sourceIdOf(id: string): string {
  return splitUnifiedId(id).id;
}

/** The id a notification's message has in the list on screen. */
export function notifiedId(unified: boolean, accountId: string, messageId: string): string {
  const id = String(messageId ?? "");
  const account = String(accountId ?? "");
  if (unified !== true || account === "" || id === "") return id;
  if (splitUnifiedId(id).accountId !== "") return id;
  return unifiedId(account, id);
}

/** A row's time, whatever shape the provider dated it in. */
export function messageTime(item: { date?: unknown; internalDate?: unknown } | null | undefined): number {
  const value = item ? item.date : null;
  if (value instanceof Date) return value.getTime();
  if (value && typeof (value as { getTime?: unknown }).getTime === "function") return (value as Date).getTime();
  const numeric = Number(value);
  if (isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(value ?? ""));
  if (isFinite(parsed) && parsed > 0) return parsed;
  return Number(item?.internalDate) || 0;
}

export interface UnifiedSource {
  id: string;
  label?: string;
  messages: readonly Summary[];
  hasMore?: boolean;
}

/** The newest of the sources' own last rows, among sources with more to come. */
export function pageWatermark(sources: readonly UnifiedSource[]): number {
  let watermark = 0;
  for (const source of Array.isArray(sources) ? sources : []) {
    const messages = Array.isArray(source?.messages) ? source.messages : [];
    if (messages.length === 0 || source.hasMore !== true) continue;
    const oldest = messageTime(messages[messages.length - 1]);
    if (oldest > watermark) watermark = oldest;
  }
  return watermark;
}

export function composeThread(accountId: string, thread: ThreadBlock | null | undefined): ThreadBlock | null | undefined {
  if (!thread || typeof thread !== "object" || !Array.isArray(thread.memberIds)) return thread;
  return { ...thread, memberIds: thread.memberIds.map((id) => unifiedId(accountId, id)) };
}

function tiebreak(left: Summary, right: Summary): number {
  const a = String(left.accountId ?? "") + " " + String(left.id ?? "");
  const b = String(right.accountId ?? "") + " " + String(right.id ?? "");
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Every source's rows, copied, addressed by account and id, newest first,
 * cut at the watermark. */
export function mergeMessages(sources: readonly UnifiedSource[] | null | undefined): Summary[] {
  const values = Array.isArray(sources) ? sources : [];
  const timed: { at: number; row: Summary }[] = [];
  const seen = new Set<string>();
  for (const source of values) {
    const accountId = String(source?.id ?? "");
    if (accountId === "") continue;
    for (const item of Array.isArray(source.messages) ? source.messages : []) {
      if (!item || String(item.id ?? "") === "") continue;
      const key = unifiedId(accountId, item.id);
      if (seen.has(key)) continue;
      seen.add(key);
      const copy: Summary = { ...item, sourceId: String(item.id), id: key, accountId };
      if (item.thread) copy.thread = composeThread(accountId, item.thread) ?? null;
      copy.sourceLabel = String(source.label || "Mailbox");
      timed.push({ at: messageTime(copy), row: copy });
    }
  }
  timed.sort((l, r) => (r.at - l.at) || tiebreak(l.row, r.row));
  const floor = pageWatermark(values);
  const out: Summary[] = [];
  for (const entry of timed) {
    if (floor > 0 && entry.at < floor) break;
    out.push(entry.row);
  }
  return out;
}

/** Checked merged rows as one batch per mailbox, in first-checked order. */
export function groupByAccount(ids: readonly string[] | null | undefined): { accountId: string; ids: string[] }[] {
  const groups: { accountId: string; ids: string[] }[] = [];
  const at = new Map<string, number>();
  for (const value of Array.isArray(ids) ? ids : []) {
    const parts = splitUnifiedId(value);
    if (parts.accountId === "") continue;
    if (!at.has(parts.accountId)) {
      at.set(parts.accountId, groups.length);
      groups.push({ accountId: parts.accountId, ids: [] });
    }
    groups[at.get(parts.accountId)!].ids.push(parts.id);
  }
  return groups;
}

/** Whether every mailbox in the merge offers a capability. */
export function everyMailboxCan(abilities: readonly Record<string, unknown>[], capability: string): boolean {
  const rows = Array.isArray(abilities) ? abilities : [];
  return rows.length > 0 && rows.every((row) => !!row && row[capability] === true);
}

export interface SourceState {
  label?: string;
  loading?: boolean;
  loaded?: boolean;
  hasMore?: boolean;
  error?: string;
  unread?: number;
}

export function totalUnread(states: readonly SourceState[]): number {
  let total = 0;
  for (const state of Array.isArray(states) ? states : []) {
    const count = Math.floor(Number(state?.unread));
    if (isFinite(count) && count > 0) total += count;
  }
  return total;
}

export function anyLoading(states: readonly SourceState[]): boolean {
  return (Array.isArray(states) ? states : []).some((s) => s?.loading === true);
}

/** Done once every mailbox loaded or stopped on an error. */
export function allLoaded(states: readonly SourceState[]): boolean {
  const values = Array.isArray(states) ? states : [];
  if (values.length === 0) return false;
  return values.every((state) => {
    if (!state) return false;
    if (state.loaded === true) return true;
    return state.loading !== true && String(state.error ?? "").trim() !== "";
  });
}

export function anyHasMore(states: readonly SourceState[]): boolean {
  return (Array.isArray(states) ? states : []).some((s) => s?.hasMore === true);
}

/** The first error, named with its mailbox. */
export function firstError(states: readonly SourceState[]): string {
  for (const state of Array.isArray(states) ? states : []) {
    const text = String(state?.error ?? "").trim();
    if (text === "") continue;
    const label = String(state.label ?? "").trim();
    return label === "" ? text : label + ": " + text;
  }
  return "";
}

export function rowIsConversation(row: Summary | null | undefined): boolean {
  return !!row?.thread && Number(row.thread.count) >= 2;
}
