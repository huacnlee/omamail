// The message list's data: what each mailbox in view has listed, paging,
// optimistic actions with undo and restore on failure, the mailbox watch and
// new-mail notifications. Port of the list halves of
// omarchy/ui/account/MailAccount.qml (loadMessages, loadMore, runNativeAction),
// BackendSync.qml, NewMailNotification.qml and the unified batch objects.
//
// Navigation and selection (cursor, selected, checked) stay in `app`; this file
// only reads them and moves them the way the Qt list did. Other features
// trigger list work through the exports at the bottom (`listStore`).
import { batch, computed, effect, Notifications, openUrl, signal, untracked } from "nsh";
import { app, type AccountRef } from "../../app/store";
import { call, on } from "../../backend/client";
import { labelIdOfMailbox } from "../../mail/labels";
import {
  capabilitiesOf, clientFor, errorCode, sentenceFor, isSignedOut, mailboxQuery, providerName, setProviderContext, unreadQuery,
  webMessageUrlAllowed, type MailClient, type ProviderContext,
} from "../../mail/list/providers";
import * as M from "../../mail/listModel";
import type { ListView, Summary } from "../../mail/listModel";
import * as listCache from "../../mail/listCache";
import { cachedFields, droppedFields, onBindDecision } from "../../mail/listCachePaint";
import { restoreChecks, unifiedBatchOutcome, type GroupResult } from "../../mail/batch";
import { accountOf, allLoaded, anyHasMore, firstError, groupByAccount, mergeMessages, notifiedId, sourceIdOf, unifiedId } from "../../mail/unified";
import { mailboxStore } from "../mailbox/store";
import { openMovePicker } from "../mailbox/MessagePicker";
import { toast } from "../../ui";
import { bringToFront } from "../../shell/windowFocus";

// ------------------------------------------------------------------ settings

export interface ListSettings {
  /** Rows per page, 5–100 (Qt `maxMessages`). */
  pageSize: number;
  /** Seconds between background checks, 30–3600. */
  refreshIntervalSec: number;
  notifyNewMail: boolean;
  /** The query the Inbox runs when the user customized it; "" for the provider's. */
  defaultQuery: string;
}

let pendingChecks: string[] = [];
/** Canned rows for the visual fixture: no backend, nothing listed or watched. */
let previewRows: Record<string, Summary[]> | null = null;
const settingsSignal = signal<ListSettings>({ pageSize: 50, refreshIntervalSec: 120, notifyNewMail: true, defaultQuery: "in:inbox" });

// ------------------------------------------------------------------ sources

interface Source {
  accountId: string;
  rows: Summary[];
  nextPageToken: string;
  estimate: number;
  loading: boolean;
  loaded: boolean;
  loadingMore: boolean;
  error: string;
  warning: string;
  /** The query this list was made with, so a stale answer can be told. */
  query: string;
}

const sourcesSignal = signal<Record<string, Source>>({});
const serials = new Map<string, number>();

function accountById(id: string): AccountRef | null {
  return app.accounts().find((a) => a.id === id) ?? null;
}

function clientOf(account: AccountRef): MailClient {
  return clientFor(account);
}

/** The list runs each account's provider session, so it reports whether the account is signed in. */
function reportSignedIn(accountId: string, signedIn: boolean) {
  if (typeof app.setAccountSignedIn === "function") app.setAccountSignedIn(accountId, signedIn);
}

/** The accounts the list is showing: every one in the unified view. */
const viewAccounts = computed<AccountRef[]>(() => {
  if (app.unified()) return app.accounts();
  const account = app.account();
  return account ? [account] : [];
});

const viewKey = computed(() => JSON.stringify([viewAccounts().map((a) => a.id + ":" + a.provider), app.mailbox(), app.query()]));

function sourceOf(accountId: string): Source {
  return sourcesSignal()[accountId] ?? {
    accountId, rows: [], nextPageToken: "", estimate: 0, loading: false, loaded: false,
    loadingMore: false, error: "", warning: "", query: "",
  };
}

function patchSource(accountId: string, patch: Partial<Source> | ((s: Source) => Partial<Source>)) {
  const current = untracked(() => sourceOf(accountId));
  const change = typeof patch === "function" ? patch(current) : patch;
  sourcesSignal.set({ ...untracked(() => sourcesSignal()), [accountId]: { ...current, ...change } });
}

// ------------------------------------------------------------------ the list

/** Every row in view, in order: the account's, or the merge of all of them. */
const messagesSignal = computed<Summary[]>(() => {
  const accounts = viewAccounts();
  const sources = sourcesSignal();
  if (app.unified()) {
    return mergeMessages(accounts.map((a) => ({
      id: a.id, label: a.label || a.email, messages: sources[a.id]?.rows ?? [], hasMore: (sources[a.id]?.nextPageToken ?? "") !== "",
    })));
  }
  return accounts[0] ? sources[accounts[0].id]?.rows ?? [] : [];
});

const statesSignal = computed(() => viewAccounts().map((a) => {
  const s = sourcesSignal()[a.id];
  return { label: a.label || a.email, loading: s?.loading ?? true, loaded: s?.loaded ?? false, hasMore: (s?.nextPageToken ?? "") !== "", error: s?.error ?? "" };
}));

const loadingSignal = computed(() => statesSignal().some((s) => s.loading));
const loadedSignal = computed(() => allLoaded(statesSignal()));
const hasMoreSignal = computed(() => anyHasMore(statesSignal()));
const errorSignal = computed(() => (app.unified() ? firstError(statesSignal()) : statesSignal()[0]?.error ?? ""));
const loadingMoreSignal = computed(() => viewAccounts().some((a) => sourcesSignal()[a.id]?.loadingMore === true));
const estimateSignal = computed(() => viewAccounts().reduce((n, a) => n + (sourcesSignal()[a.id]?.estimate ?? 0), 0));

/** The view as the action rules read it. */
function listView(): ListView {
  const labelId = labelIdOfMailbox(app.mailbox());
  return {
    mailboxKey: labelId === "" ? app.mailbox() : "",
    searchQuery: app.query(),
    rawQuery: labelId === "" ? "" : "label:" + labelId,
    canReportSpamFor: (id: string) => {
      const account = accountById(app.unified() ? accountOf(id) : app.accountId());
      return account ? capabilitiesOf(account.provider).spam : false;
    },
  };
}

/** The account a row belongs to and the id its provider calls it. */
export function ownerOf(id: string): { accountId: string; sourceId: string } {
  if (app.unified() || accountOf(id) !== "") {
    const accountId = accountOf(id);
    if (accountId !== "") return { accountId, sourceId: sourceIdOf(id) };
  }
  return { accountId: app.accountId(), sourceId: String(id ?? "") };
}

function rowsOf(ids: readonly string[]): Summary[] {
  return M.summariesById(untracked(() => messagesSignal()), ids);
}

// ------------------------------------------------------------------ queries

async function resolveQuery(account: AccountRef): Promise<string> {
  const key = app.mailbox();
  const labelId = labelIdOfMailbox(key);
  const search = app.query().trim();
  if (labelId !== "") {
    const label = mailboxStore.labelById(account.id, labelId);
    const name = String(label?.rawName ?? label?.name ?? labelId);
    const result: any = await call("providers.resolve", { provider: account.provider, operation: "labelQuery", value: name });
    return String(result?.value ?? "");
  }
  const defaultQuery = settingsSignal().defaultQuery;
  const customInbox = key === "inbox" && defaultQuery !== "" && defaultQuery !== "in:inbox";
  if (search !== "" || customInbox) {
    const result: any = await call("providers.resolve", { provider: account.provider, operation: "query", mailbox: key, search, defaultQuery });
    return String(result?.value ?? "");
  }
  return mailboxQuery(account.provider, key);
}

async function summarize(payloads: unknown[]): Promise<Summary[]> {
  if (payloads.length === 0) return [];
  const result: any = await call("message.summaries", { messages: payloads, now: Date.now() });
  const summaries: any[] = Array.isArray(result?.summaries) ? result.summaries : [];
  if (summaries.length !== payloads.length) throw new Error("Incomplete message summaries");
  const now = new Date();
  return summaries.map((raw) => M.hydrateSummary(raw, now));
}

/** Rows in the order the listing gave their ids. */
function inPageOrder(ids: readonly string[], rows: Summary[]): Summary[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: Summary[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (row) out.push(row);
  }
  return out;
}

// ------------------------------------------------------------------ loading

/** Lists one account's view: a reload at the depth the user paged to, or the next page. */
async function loadSource(account: AccountRef, append: boolean, options: { skipCache?: boolean } = {}) {
  if (previewRows) return;
  const serial = (serials.get(account.id) ?? 0) + 1;
  serials.set(account.id, serial);
  const stale = () => serials.get(account.id) !== serial;
  const before = untracked(() => sourceOf(account.id));
  const client = clientOf(account);
  if (!append) client.cancel();
  patchSource(account.id, append ? { loadingMore: true } : { loading: true });
  /** The live answer arrived: a cached preview no longer paints. */
  let live = false;
  /** The live load failed: a later cache paint keeps its error in view. */
  let failed = false;
  try {
    const query = append ? before.query : await resolveQuery(account);
    if (stale()) return;
    const pageSize = settingsSignal().pageSize;
    // Cache first (Qt paintFromCache): what the last visit to this query left,
    // and for a typed search every cached row that matches, painted while the
    // live load runs. The live answer replaces it, so a stale preview never
    // survives. A reload after an action or a push skips it: the rows on
    // screen are newer than the cache.
    if (!append && options.skipCache !== true) {
      const search = labelIdOfMailbox(untracked(() => app.mailbox())) === "" ? untracked(() => app.query()).trim() : "";
      // One cache read at a time: a bind landing while a read waits on it adds none.
      let painting = false;
      const paint = () => {
        painting = true;
        void listCache.preview(account.id, query, pageSize, search).then((cached) => {
          painting = false;
          if (!cached || stale() || live) return;
          patchSource(account.id, (s) => cachedFields(s, cached, query, failed));
          afterReload();
        });
      };
      // Unbound yet (the server has not said who the mailbox is): the paint
      // waits for the bind, as Qt's painted on its cache's `restored`.
      waitingPaints.set(account.id, (replaced: boolean) => {
        const decision = onBindDecision({ stale: stale(), live }, replaced);
        if (decision === "ignore") return;
        if (decision === "drop-then-paint") patchSource(account.id, droppedFields());
        if (!painting) paint();
      });
      hearBinds();
      paint();
    }
    const limit = append ? pageSize : M.reloadLimit(pageSize, before.query === query ? before.rows.length : 0);
    const page = await client.list(query, limit, append ? before.nextPageToken : "");
    if (stale()) return;
    const read = page.ids.length > 0 ? await client.read(page.ids) : { messages: [], warning: "" };
    if (stale()) return;
    const rows = inPageOrder(page.ids, await summarize(read.messages));
    if (stale()) return;
    live = true;
    waitingPaints.delete(account.id);
    patchSource(account.id, (s) => {
      const merged = append ? s.rows.concat(rows.filter((r) => M.indexById(s.rows, r.id) < 0)) : rows;
      return {
        rows: !append && M.sameSummaries(s.rows, merged) ? s.rows : merged,
        nextPageToken: page.nextPageToken, estimate: page.estimate, query,
        loading: false, loadingMore: false, loaded: true, error: "", warning: page.warning || read.warning,
      };
    });
    reportSignedIn(account.id, true);
    afterReload();
    // What the list shows, written back; only a complete answer, so an
    // incomplete search never becomes the cached truth.
    if (!page.warning && !read.warning) rememberSource(account.id);
  } catch (error) {
    if (stale()) return;
    // A failure is no answer: a cache paint that arrives after it still shows
    // (offline, the cached rows under the error), as Qt's did.
    failed = true;
    if (isSignedOut(error)) reportSignedIn(account.id, false);
    const text = errorCode(error) || "Could not load messages";
    // A cached continuation was never revalidated: paging with it could skip rows.
    patchSource(account.id, append
      ? { loading: false, loadingMore: false, error: friendly(account, text) }
      : { loading: false, loadingMore: false, nextPageToken: "", error: friendly(account, text) });
  }
}

/** A view's cache paint waiting for its account's bind, by account. */
const waitingPaints = new Map<string, (replaced: boolean) => void>();
let hearingBinds = false;
function hearBinds() {
  if (hearingBinds) return;
  hearingBinds = true;
  listCache.onBound((accountId, replaced) => waitingPaints.get(accountId)?.(replaced));
}

/** Writes the account's list as shown to the query cache (Qt `rememberList`). */
function rememberSource(accountId: string) {
  if (previewRows) return;
  const s = untracked(() => sourceOf(accountId));
  if (!s.loaded || s.query === "") return;
  void listCache.remember(accountId, s.query, untracked(() => settingsSignal()).pageSize, {
    summaries: s.rows, estimate: s.estimate, nextPageToken: s.nextPageToken,
  });
}

/** After an action: drop every cached page holding the reached ids, then keep the list as it now stands. */
function refreshCache(accountId: string, targets: readonly string[]) {
  if (previewRows || targets.length === 0) return;
  void listCache.invalidate(accountId, targets).then(() => rememberSource(accountId));
}

/** What the user reads for a failed listing: our own sentences only, never a server's text. */
function friendly(account: AccountRef, code: string): string {
  if (code.startsWith("Sign in to ")) return code;
  const mapped = sentenceFor(account.provider, code);
  if (/could not complete this request$/.test(mapped)) return providerName(account.provider) + " could not list this mailbox";
  return mapped;
}

/** After the list was replaced: the cursor stays on its row, or the top; checks drop rows that left. */
function afterReload() {
  const list = untracked(() => messagesSignal());
  batch(() => {
    const cursor = untracked(() => app.cursorId());
    if (cursor !== "" && M.indexById(list, cursor) < 0 && untracked(() => app.selectedId()) !== cursor) {
      app.moveCursor(M.cursorAfterReload(list, cursor));
    }
    const checked = untracked(() => app.checked());
    const kept = M.retainIds(checked, list);
    const restored = restoreChecks(kept, pendingChecks, (id) => M.indexById(list, id) >= 0);
    pendingChecks = restored.waiting;
    if (restored.checked.length !== checked.length || restored.checked.some((id, i) => id !== checked[i])) app.setChecked(restored.checked);
  });
}

/** Reloads every mailbox in view (F5, a push, a revalidation). */
export function refresh(options: { check?: boolean } = {}) {
  for (const account of untracked(() => viewAccounts())) {
    void loadSource(account, false);
    if (options.check) void checkNow(account.id);
  }
}

/** The next page of every mailbox in view that has one. */
export function loadMore() {
  for (const account of untracked(() => viewAccounts())) {
    const s = untracked(() => sourceOf(account.id));
    if (s.nextPageToken !== "" && !s.loadingMore && !s.loading) void loadSource(account, true);
  }
}

// A new view (account, mailbox, label or search) replaces the list.
let lastViewKey = "";
effect(() => {
  const key = viewKey();
  if (key === lastViewKey) return;
  lastViewKey = key;
  untracked(() => {
    pendingChecks = [];
    if (previewRows) return;
    const accounts = viewAccounts();
    const next: Record<string, Source> = { ...sourcesSignal() };
    for (const a of accounts) next[a.id] = { ...sourceOf(a.id), rows: [], nextPageToken: "", loaded: false, loading: true, error: "", query: "" };
    sourcesSignal.set(next);
    for (const a of accounts) void loadSource(a, false);
  });
});

// ------------------------------------------------------------------ actions

interface Pending {
  accountId: string;
  /** The acted rows as they were, with the ids the merged list gives them. */
  rows: Summary[];
  /** The account's whole list before the action, in its own ids: where restored rows go. */
  all: Summary[];
}
const chains = new Map<string, Promise<unknown>>();

function serialized<T>(accountId: string, work: () => Promise<T>): Promise<T> {
  const previous = chains.get(accountId) ?? Promise.resolve();
  const next = previous.then(work, work);
  chains.set(accountId, next.catch(() => {}));
  return next;
}

/** What a key or the batch bar acts on: the checked rows, else the cursor's (App.qml actionIds). */
function defaultTargets(): string[] {
  const checked = untracked(() => app.checked());
  if (checked.length > 0) return checked.slice();
  const id = untracked(() => app.cursorId() || app.selectedId());
  return id === "" ? [] : [id];
}

export interface ActOptions {
  /** No note and no toast: a mark-read on opening, an undo's own change. */
  quiet?: boolean;
  /** The words for a move's destination ("Receipts"). */
  labelName?: string;
  /** "Mark these read": Qt's own note ("3 conversations marked read"), no undo. */
  allRead?: boolean;
}

/** Runs `action` on `ids` (default: what the cursor's row reaches). Optimistic:
 * the rows change at once, a failure puts the failed ones back, success
 * offers Undo where the verb has an inverse. False when nothing was sent. */
export function act(action: string, ids?: readonly string[], options: ActOptions = {}): boolean {
  const reached = ids && ids.length > 0 ? ids.slice() : defaultTargets();
  if (reached.length === 0) return false;
  const groups = untracked(() => app.unified())
    ? groupByAccount(reached).map((g) => ({ accountId: g.accountId, ids: g.ids.map((id) => unifiedId(g.accountId, id)) }))
    : [{ accountId: untracked(() => app.accountId()), ids: reached }];
  // Capability: refuse with the provider's reason rather than send what it cannot do.
  const needs = M.actionCapability(action);
  for (const group of groups) {
    const account = accountById(group.accountId);
    if (!account) return false;
    const caps = capabilitiesOf(account.provider) as unknown as Record<string, boolean>;
    if (needs !== "" && caps[needs] !== true) {
      toast({ title: M.actionUnavailable(action, providerName(account.provider)), kind: "warning" });
      return false;
    }
  }
  const view = untracked(() => listView());
  const list = untracked(() => messagesSignal());
  const labelId = labelIdOfMailbox(untracked(() => app.mailbox()));
  const label = M.actionLabel(action, (target) => options.labelName || target);
  // The rows as they were, for undo and restore; the rows that will leave.
  const before: Pending[] = groups.map((g) => ({
    accountId: g.accountId, rows: M.summariesById(list, g.ids), all: untracked(() => sourceOf(g.accountId)).rows.slice(),
  }));
  const leaving: string[] = [];
  for (const group of before) {
    const account = accountById(group.accountId)!;
    const labels = capabilitiesOf(account.provider).labels;
    const source = labels ? labelId : "";
    for (const row of group.rows) {
      const after = M.rowAfterAction(row, action, source);
      if (!M.survivesAction(view.mailboxKey || "label", action, view.rawQuery, labels, source, after)) leaving.push(row.id);
    }
  }
  // The cursor and the open message move off rows that leave, before they go.
  batch(() => {
    const cursor = untracked(() => app.cursorId());
    const selected = untracked(() => app.selectedId());
    const nextCursor = leaving.includes(cursor) ? M.cursorAfterRemovals(list, leaving, cursor) : cursor;
    if (leaving.includes(selected) && untracked(() => app.readerOpen())) {
      if (nextCursor !== "") app.select(nextCursor);
      else app.closeReader();
    }
    if (nextCursor !== cursor) app.moveCursor(nextCursor);
    const checked = untracked(() => app.checked());
    if (checked.some((id) => reached.includes(id))) app.setChecked(checked.filter((id) => !reached.includes(id)));
    for (const group of before) applyOptimistic(group, action, labelId, leaving);
  });
  // The cached copy follows the optimistic list at once (Qt `rememberList`),
  // so a cache-first paint before the reply cannot bring the old state back.
  for (const group of before) rememberSource(group.accountId);
  // One request per mailbox; the results come back together.
  const results = groups.map((group, index) => dispatch(group.accountId, before[index].rows, group.ids, action, labelId));
  void Promise.all(results).then((outcomes) => settle(action, label, before, outcomes, options, labelId));
  return true;
}

function sourceRowId(accountId: string, id: string): string {
  return untracked(() => app.unified()) ? sourceIdOf(id) || id : id;
}

function applyOptimistic(group: Pending, action: string, labelId: string, leaving: readonly string[]) {
  const account = accountById(group.accountId);
  if (!account) return;
  const source = capabilitiesOf(account.provider).labels ? labelId : "";
  patchSource(group.accountId, (s) => {
    const gone = leaving.map((id) => sourceRowId(group.accountId, id));
    const touched = new Set(group.rows.map((r) => sourceRowId(group.accountId, r.id)));
    return { rows: s.rows.filter((r) => !gone.includes(r.id)).map((r) => (touched.has(r.id) ? M.rowAfterAction(r, action, source) : r)) };
  });
}

async function dispatch(accountId: string, rows: Summary[], ids: readonly string[], action: string, labelId: string): Promise<GroupResult> {
  if (previewRows) return { accountId, ids: ids.map((id) => sourceRowId(accountId, id)), failedIds: [] };
  const account = accountById(accountId);
  const ownIds = ids.map((id) => sourceRowId(accountId, id));
  if (!account) return { accountId, ids: ownIds, failedIds: null };
  const source = capabilitiesOf(account.provider).labels ? labelId : "";
  // Expansion is the row's: a conversation verb reaches every counted member.
  const targets: string[] = [];
  const known = new Map(rows.map((r) => [sourceRowId(accountId, r.id), r]));
  for (const id of ownIds) {
    const row = known.get(id);
    const own = row ? M.actionTargets({ ...row, id, thread: row.thread ? { ...row.thread, memberIds: row.thread.memberIds.map((m) => sourceRowId(accountId, m)) } : null }, action) : [id];
    for (const t of own) if (!targets.includes(t)) targets.push(t);
  }
  const client = clientOf(account);
  const result = await serialized(accountId, () => client.act(action, targets, source));
  // A failed member fails its row.
  lastErrors.set(accountId, result.error);
  if (result.error !== "" && result.failedIds.length === 0) return { accountId, ids: ownIds, failedIds: null, targets };
  const failedRows = ownIds.filter((id) => {
    const row = known.get(id);
    const own = row ? { ...row, id, thread: row.thread ? { ...row.thread, memberIds: row.thread.memberIds.map((m) => sourceRowId(accountId, m)) } : null } : null;
    const reach = own ? M.actionTargets(own, action) : [id];
    return reach.some((t) => result.failedIds.includes(t));
  });
  return { accountId, ids: ownIds, failedIds: failedRows, targets };
}

const lastErrors = new Map<string, string>();

function settle(action: string, label: string, before: Pending[], outcomes: GroupResult[], options: ActOptions, labelId: string) {
  const unified = untracked(() => app.unified());
  let failedTotal = 0;
  let asked = 0;
  let firstFailure = "";
  for (let i = 0; i < outcomes.length; i++) {
    const outcome = outcomes[i];
    const failed = outcome.failedIds === null ? outcome.ids : outcome.failedIds;
    asked += outcome.ids.length;
    failedTotal += failed.length;
    if (failed.length > 0) {
      firstFailure ||= lastErrors.get(outcome.accountId) || "The change was not applied";
      // Put back exactly the rows whose request failed, where they were.
      patchSource(outcome.accountId, (s) => ({ rows: M.restoreRows(s.rows, before[i].all, failed) }));
      if (unified) pendingChecks = pendingChecks.concat(failed.map((id) => unifiedId(outcome.accountId, id)));
      // What the server holds is no longer certain: read it again.
      const account = accountById(outcome.accountId);
      if (account) void loadSource(account, false, { skipCache: true });
    }
    refreshCache(outcome.accountId, outcome.targets ?? outcome.ids);
  }
  if (unified && outcomes.length > 1) {
    const result = unifiedBatchOutcome(label, outcomes, (id) => accountById(id)?.label || id);
    app.setNotice(result.status);
    if (failedTotal > 0) toast({ title: result.status, kind: "error" });
    else if (!options.quiet) offerUndo(action, label, before, asked, labelId, options);
    return;
  }
  if (failedTotal > 0) {
    const text = asked > 1 ? M.batchFailureNote(asked, failedTotal, label, firstFailure) : firstFailure;
    app.setNotice(text);
    toast({ title: text, kind: "error" });
    return;
  }
  if (!options.quiet) offerUndo(action, label, before, asked, labelId, options);
}

function offerUndo(action: string, label: string, before: Pending[], count: number, labelId: string, options: ActOptions = {}) {
  if (options.allRead) {
    // Qt notes "Mark these read" and offers no undo; the noun follows the rows.
    const expanded = before.some((g) => g.rows.some((r) => M.actionTargets(r, action).length > 1));
    const note = M.markAllReadNote(count, expanded);
    app.setNotice(note);
    toast({ title: note, kind: "success" });
    return;
  }
  const text = count > 1 ? M.batchNote(count, label) : label;
  app.setNotice(text);
  const inverse = M.inverseAction(action);
  if (inverse === "") {
    toast({ title: text, kind: "success" });
    return;
  }
  toast({
    title: text, kind: "success",
    action: { label: "Undo", onAction: () => undo(inverse, before, labelId) },
  });
}

/** Puts the rows back as they were and sends the inverse verb. */
function undo(inverse: string, before: Pending[], labelId: string) {
  batch(() => {
    for (const group of before) {
      const ids = group.rows.map((r) => sourceRowId(group.accountId, r.id));
      patchSource(group.accountId, (s) => ({ rows: M.restoreRows(s.rows, group.all, ids) }));
    }
  });
  void Promise.all(before.map((group) => dispatch(group.accountId, group.rows, group.rows.map((r) => r.id), inverse, labelId)))
    .then((outcomes) => {
      for (const outcome of outcomes) refreshCache(outcome.accountId, outcome.targets ?? outcome.ids);
      const failed = outcomes.some((o) => o.failedIds === null || o.failedIds.length > 0);
      if (failed) {
        toast({ title: "Could not undo: " + (lastErrors.get(outcomes[0]?.accountId ?? "") || "the change stayed"), kind: "error" });
        refresh();
      } else app.setNotice("Undone");
    });
}

/** Qt `canOpenWebInbox`: one mailbox in view (not unified) whose provider has `webBox`. */
export function canOpenWebInbox(): boolean {
  if (app.unified()) return false;
  const account = accountById(app.accountId());
  return !!account && capabilitiesOf(account.provider).webBox;
}

/** "Open web inbox..." (app menu): the provider's web view of the query this
 * list shows, as Qt's `openWebInbox` (`webBoxUrl` over the effective query). */
export async function openWebInbox() {
  if (!untracked(() => canOpenWebInbox())) return;
  const account = accountById(untracked(() => app.accountId()))!;
  const query = untracked(() => sourceOf(account.id)).query || mailboxQuery(account.provider, untracked(() => app.mailbox()));
  try {
    const result: any = await call("providers.resolve", { provider: account.provider, operation: "webBoxUrl", value: query });
    const url = String(result?.value ?? "");
    // The query is the user's, the host is ours: open only on the provider's own web mail.
    if (webMessageUrlAllowed(account.provider, url)) await openUrl(url);
    else toast({ title: "Could not open the web inbox", kind: "error" });
  } catch {
    toast({ title: "Could not open the web inbox", kind: "error" });
  }
}

/** The verb a slot key asks for over the rows it reaches (`e`, `d`, `s`). */
export function keyAction(slot: "archive" | "trash" | "star", ids?: readonly string[]): string {
  const reached = ids && ids.length > 0 ? ids.slice() : defaultTargets();
  const rows = rowsOf(reached);
  if (slot === "star") return M.starActionFor(rows);
  return M.keyActionFor(slot, rows, untracked(() => listView()));
}

/** Runs a slot key: archive / trash / star with their inverses where done. */
export function actSlot(slot: "archive" | "trash" | "star", ids?: readonly string[]): boolean {
  return act(keyAction(slot, ids), ids);
}

/** Opens the message on the provider's web mail. */
export async function openInBrowser(id: string) {
  const owner = ownerOf(id);
  const account = accountById(owner.accountId);
  if (!account || !capabilitiesOf(account.provider).web) return;
  try {
    const result: any = await call("providers.resolve", { provider: account.provider, operation: "webMessageUrl", value: owner.sourceId });
    const url = String(result?.value ?? "");
    // The URL is built from a server-controlled id: open it only on the provider's own web mail.
    if (webMessageUrlAllowed(account.provider, url)) await openUrl(url);
    else toast({ title: "Could not open this message in the browser", kind: "error" });
  } catch {
    toast({ title: "Could not open this message in the browser", kind: "error" });
  }
}

/** "Mark these read" (the app menu): Qt's `markAllRead`. It marks the
 * unread rows that are loaded, not every message the mailbox holds (Qt's menu
 * says "these" for that reason), each mailbox on its own in a unified list,
 * and does nothing when nothing loaded is unread. */
export function markAllRead(): boolean {
  const unread = untracked(() => messagesSignal()).filter((r) => r.unread).map((r) => r.id);
  if (unread.length === 0) return false;
  if (!untracked(() => app.unified())) return act("markRead", unread, { allRead: true });
  let sent = false;
  for (const group of groupByAccount(unread)) {
    const ids = group.ids.map((id) => unifiedId(group.accountId, id));
    if (act("markRead", ids, { allRead: true })) sent = true;
  }
  return sent;
}

/** "Move to..." (v): the mailbox feature's picker chooses, the list moves. */
export function openMove(ids?: readonly string[]): boolean {
  const targets = ids && ids.length > 0 ? ids.slice() : defaultTargets();
  if (targets.length === 0) return false;
  return openMovePicker(targets, (labelId, chosen) => {
    const name = mailboxStore.labelPathOf(mailboxStore.labelById(ownerOf(chosen[0] ?? "").accountId, labelId)) || labelId;
    act(M.MOVE_PREFIX + labelId, chosen, { labelName: name });
  });
}

// ------------------------------------------------------------------ cursor

/** Steps the cursor and opens the row in the reader, as j / k do. */
export function moveCursor(delta: number) {
  const list = untracked(() => messagesSignal());
  const next = M.cursorAfterOffset(list, untracked(() => app.cursorId()), delta);
  if (next !== "") app.select(next);
}

/** Opens the cursor's row (Return, o, Right). */
export function openCursor() {
  const id = untracked(() => app.cursorId()) || (untracked(() => messagesSignal())[0]?.id ?? "");
  if (id !== "") app.select(id);
}

export function toggleCheck(id?: string) {
  const target = id ?? (untracked(() => app.cursorId()) || untracked(() => app.selectedId()));
  if (target === "") return;
  app.setChecked(M.toggleId(untracked(() => app.checked()), target));
}

/** Shift+click: the clicked row's next state over the range from the cursor; the cursor moves to it. */
export function checkRange(toId: string) {
  const list = untracked(() => messagesSignal());
  batch(() => {
    app.setChecked(M.toggleRange(untracked(() => app.checked()), list, untracked(() => app.cursorId()), toId));
    app.moveCursor(toId);
  });
}

/** Ctrl+A: every loaded row, or none. */
export function checkAll() {
  app.setChecked(M.checkAllToggle(untracked(() => app.checked()), untracked(() => messagesSignal())));
}

/** Escape: unticks first; true when it did something. */
export function clearChecks(): boolean {
  if (untracked(() => app.checked()).length === 0) return false;
  app.setChecked([]);
  return true;
}

// ------------------------------------------------------------------ watch

interface Watch { key: string; sequence: number; primed: boolean; seen: Record<string, boolean>; floor: number; retry: number }
const watches = new Map<string, Watch>();

function watchKey(account: AccountRef): string {
  const s = settingsSignal();
  return JSON.stringify([account.id, unreadQuery(account.provider), s.refreshIntervalSec, s.pageSize]);
}

async function register(account: AccountRef) {
  if (previewRows) return;
  hearSnapshots();
  const key = watchKey(account);
  const existing = watches.get(account.id);
  if (existing && existing.key === key) return;
  const entry: Watch = existing ? { ...existing, key } : { key, sequence: -1, primed: false, seen: {}, floor: 0, retry: 0 };
  watches.set(account.id, entry);
  const s = untracked(() => settingsSignal());
  try {
    const snapshot: any = await call("mail.watch", {
      accountId: account.id, query: unreadQuery(account.provider),
      intervalSec: Math.max(30, Math.min(3600, s.refreshIntervalSec)), pageSize: Math.max(5, Math.min(100, s.pageSize)),
    });
    if (watches.get(account.id) !== entry) return;
    if (snapshot && typeof snapshot === "object") void onSnapshot(snapshot);
  } catch (error) {
    if (watches.get(account.id) !== entry) return;
    if (isSignedOut(error)) reportSignedIn(account.id, false);
    // Registration failed: try again shortly, as BackendSync did.
    entry.key = "";
    clearTimeout(entry.retry);
    entry.retry = setTimeout(() => {
      const again = accountById(account.id);
      if (again) void register(again);
    }, 5000);
  }
}

function unregister(accountId: string) {
  const entry = watches.get(accountId);
  if (entry) clearTimeout(entry.retry);
  watches.delete(accountId);
  call("mail.unwatch", { accountId }).catch(() => {});
}

async function checkNow(accountId: string) {
  try {
    await call("mail.check", { accountId });
  } catch (error) {
    if (errorCode(error) !== "mail_watch_unknown") return;
    const entry = watches.get(accountId);
    if (entry) entry.key = "";
    const account = accountById(accountId);
    if (account) void register(account);
  }
}

async function onSnapshot(snapshot: any) {
  const accountId = String(snapshot?.accountId ?? "");
  const entry = watches.get(accountId);
  if (!entry || snapshot.error || typeof snapshot.sequence !== "number" || snapshot.sequence <= entry.sequence) return;
  entry.sequence = snapshot.sequence;
  const estimate = Math.max(0, Math.floor(Number(snapshot.estimate)) || 0);
  mailboxStore.setInboxUnread(accountId, estimate);
  let summaries: Summary[] = [];
  try {
    summaries = (await summarize(Array.isArray(snapshot.messages) ? snapshot.messages : []))
      .map((s) => ({ ...s, unread: true, inInbox: s.inInbox !== false }));
  } catch {
    return;
  }
  if (!entry.primed) {
    entry.primed = true;
    entry.floor = M.newestDate(summaries);
    for (const s of summaries) entry.seen[s.id] = true;
  } else {
    const arrivals = M.newArrivals(summaries, entry.seen, true, entry.floor);
    for (const s of summaries) entry.seen[s.id] = true;
    if (arrivals.length > 0) void notify(accountId, arrivals);
  }
  // A mailbox in view that changed is read again, quietly.
  if (untracked(() => viewAccounts()).some((a) => a.id === accountId)) {
    const account = accountById(accountId);
    const s = untracked(() => sourceOf(accountId));
    if (account && !s.loading) void loadSource(account, false);
  }
}

// Subscribed with the first watch, not at module load: `on` starts the
// backend's event stream, which a preview must never reach.
let hearingSnapshots = false;
function hearSnapshots() {
  if (hearingSnapshots) return;
  hearingSnapshots = true;
  on("mail.updated", (params: any) => void onSnapshot(params?.snapshot ?? params));
}

// Watch every account; stop watching the ones removed.
effect(() => {
  const accounts = app.accounts();
  settingsSignal();
  untracked(() => {
    for (const id of [...watches.keys()]) if (!accounts.some((a) => a.id === id)) unregister(id);
    for (const account of accounts) void register(account);
  });
});

// ------------------------------------------------------------------ notifications

function notificationId(accountId: string, messageId: string): string {
  return "mail:" + JSON.stringify([accountId, messageId]);
}

/** Whether the system lets the app notify, asking once when it has not been asked
 * ("default"). `show` resolves false without it, which is why arrivals were silent.
 * "unavailable" is a build that cannot notify (an unsigned macOS bundle, a terminal). */
let permission: Promise<string> | null = null;
export function ensureNotificationPermission(): Promise<string> {
  if (!permission) {
    permission = Notifications.permission()
      .then((state) => (state === "default" ? Notifications.requestPermission() : state))
      .catch(() => "unavailable");
    // A refusal can change in the system's settings: ask the system again next time.
    void permission.then((state) => {
      if (state !== "granted") permission = null;
    });
  }
  return permission;
}

async function notify(accountId: string, arrivals: Summary[]) {
  if (!untracked(() => settingsSignal()).notifyNewMail) return;
  const notice = M.arrivalNotice(arrivals);
  if (!notice) return;
  const state = await ensureNotificationPermission();
  if (state !== "granted") return;
  await Notifications.show({ id: notificationId(accountId, arrivals[0].id), title: notice.title, body: notice.body })
    .catch(() => false);
}

function openNotification(id: string) {
  if (!id.startsWith("mail:")) return;
  let parts: unknown;
  try {
    parts = JSON.parse(id.slice(5));
  } catch {
    return;
  }
  if (!Array.isArray(parts) || parts.length !== 2) return;
  const accountId = String(parts[0] ?? "");
  const messageId = String(parts[1] ?? "");
  if (!accountById(accountId) || messageId === "") return;
  batch(() => {
    if (!app.unified() && app.accountId() !== accountId) app.openAccount(accountId);
    if (app.mailbox() !== "inbox" || app.query() !== "") {
      app.search("");
      app.openMailbox("inbox");
    }
    app.openPage("mail");
    app.select(notifiedId(app.unified(), accountId, messageId));
  });
  // Qt's WindowFocus: the person pressed the notification to see this message.
  bringToFront();
}

try {
  Notifications.on("press", (press) => openNotification(String(press?.id ?? "")));
} catch {
  // The notifications capability is not granted: arrivals stay silent.
}

// ------------------------------------------------------------------ menu target

/** The message a context menu was opened for; "" while none is open. */
const menuTargetSignal = signal<string>("");

// ------------------------------------------------------------------ exports

/** What other features read and trigger. */
export const listStore = {
  messages: () => messagesSignal(),
  loading: () => loadingSignal(),
  loaded: () => loadedSignal(),
  loadingMore: () => loadingMoreSignal(),
  hasMore: () => hasMoreSignal(),
  error: () => errorSignal(),
  estimate: () => estimateSignal(),
  view: listView,
  ownerOf,
  rowFor: (id: string) => M.summariesById(messagesSignal(), [id])[0] ?? null,
  capabilitiesFor: (id: string) => {
    const account = accountById(ownerOf(id).accountId);
    return capabilitiesOf(account ? account.provider : "gmail");
  },
  menuTarget: () => menuTargetSignal(),
  setMenuTarget: (id: string) => menuTargetSignal.set(id),
  refresh,
  loadMore,
  act,
  actSlot,
  keyAction,
  openInBrowser,
  canOpenWebInbox,
  openWebInbox,
  moveCursor,
  openCursor,
  toggleCheck,
  checkRange,
  checkAll,
  clearChecks,
  /** Settings the list follows (the settings feature calls it). */
  configure(patch: Partial<ListSettings>) {
    settingsSignal.set({ ...untracked(() => settingsSignal()), ...patch });
  },
  settings: () => settingsSignal(),
  /** Asks the system to let new-mail notifications show (settings calls it when turned on). */
  requestNotifications: ensureNotificationPermission,
  /** Fixture only: shows these rows per account and never asks the backend. */
  preview(rows: Record<string, Summary[]>) {
    previewRows = rows;
    const next: Record<string, Source> = {};
    for (const [accountId, list] of Object.entries(rows)) {
      next[accountId] = { ...untracked(() => sourceOf(accountId)), rows: list, loading: false, loaded: true, error: "", nextPageToken: "" };
    }
    sourcesSignal.set(next);
  },
  /** What a provider's sign-in knows that list requests need (HEY's program). */
  setProviderContext(accountId: string, context: ProviderContext) {
    setProviderContext(accountId, context);
  },
  markAllRead,
  openMove,
};

/** The rows on screen (the reader and shell read it). */
export function messages(): Summary[] {
  return messagesSignal();
}
