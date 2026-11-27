// The list's half of the query cache (port of omarchy/ui/cache/CacheStore.qml
// as MailAccount.qml used it). Core owns the cached pages, matching, expiry,
// eviction and the private file under $XDG_CACHE_HOME/omamail; this file only
// asks it: restore an account's cache and hold its generation, read a view's
// cached page (with a local search over every cached row), write back what
// the list showed, and drop pages an action made stale.
//
// Every request carries the generation the last `cache.queryRestore` gave;
// core refuses an older one (`cache_stale_generation`), and the request is
// restored and tried once more. Nothing here runs at module load.
//
// Privacy, as in Qt: only the summaries the list already drew are written
// (sender, recipients, subject, snippet, flags; never a body), bound to the
// mailbox address the account owner binds with `bindAccount` (unbound, the
// list neither paints from the cache nor writes to it), and core keeps
// the file private and capped. A cached search is a preview: the live answer
// replaces it and only that answer is written back.
import { call } from "../backend/client";
import { hydrateSummary, type Summary } from "./listModel";

/** A cached page as core returns it. */
export interface CachedPage {
  summaries: Summary[];
  estimate: number;
  nextPageToken: string;
}

/** What a view paints from before the live answer. */
export interface CachePreview {
  /** The view's own cached page, if it has one, merged with local search matches, newest first. */
  summaries: Summary[];
  /** The view's own entry (its estimate and continuation), null for a first visit. */
  entry: { estimate: number; nextPageToken: string } | null;
}

interface AccountCache {
  generation: number;
  /** Bumped by every restore: an answer for an older epoch is dropped. */
  epoch: number;
  restoring: Promise<boolean> | null;
  loaded: boolean;
  /** The mailbox address the account owner bound this cache to ("" until then). */
  boundTo: string;
  /** A bind in flight: a paint waits for it rather than refusing. */
  binding: Promise<boolean> | null;
}

const accounts = new Map<string, AccountCache>();
/** `replaced`: the cache was bound to another address before, and core emptied it for this one. */
type BoundListener = (accountId: string, replaced: boolean) => void;
const boundListeners = new Set<BoundListener>();

/**
 * Hears each account whose cache became bound: the list paints a view still
 * waiting for its live answer, and drops what it painted when the address
 * changed (those rows were another identity's).
 */
export function onBound(listener: BoundListener): () => void {
  boundListeners.add(listener);
  return () => boundListeners.delete(listener);
}

/** The cache key core files a view's page under ("query|limit"), as Qt's `cacheKey`. */
export function cacheKey(query: string, limit: number): string {
  return String(query ?? "").trim() + "|" + Math.max(1, Math.floor(Number(limit)) || 1);
}

/** The address in an account id ("imap:jane@example.com"), as core reads it. */
function idAddress(accountId: string): string {
  const at = accountId.indexOf(":");
  return (at < 0 ? accountId : accountId.slice(at + 1)).trim().toLowerCase();
}

function announceBound(accountId: string, replaced = false) {
  for (const listener of [...boundListeners]) {
    try {
      listener(accountId, replaced);
    } catch {
      // A listener's failure never unbinds the cache.
    }
  }
}

function stateOf(accountId: string): AccountCache {
  let state = accounts.get(accountId);
  if (!state) {
    state = { generation: 0, epoch: 0, restoring: null, loaded: false, boundTo: "", binding: null };
    accounts.set(accountId, state);
  }
  return state;
}

function codeOf(error: unknown): string {
  return error && typeof error === "object" && "message" in error ? String((error as Error).message ?? "") : String(error ?? "");
}

/** Restores the account's cache (again): a new generation. False when the cache is unavailable. */
export function restore(accountId: string): Promise<boolean> {
  if (!accountId) return Promise.resolve(false);
  const state = stateOf(accountId);
  const epoch = ++state.epoch;
  state.loaded = false;
  state.generation = 0;
  const restoring = call("cache.queryRestore", { accountId })
    .then((value: any) => {
      if (state.epoch !== epoch) return state.restoring ?? Promise.resolve(false);
      const generation = Number(value?.generation);
      if (!Number.isFinite(generation) || generation <= 0) return false;
      state.generation = generation;
      state.loaded = true;
      // A store core restored still holds the address the server confirmed
      // last time (only a bind or the profile writes it, and core empties a
      // store whose address is not this id's). Checked again here: it counts
      // as bound at once, so a mailbox seen before paints offline, as Qt
      // painted from its restored store before getProfile answered. The
      // server's answer still binds again; an empty address stays unbound.
      const stored = String(value?.store?.account ?? "").trim();
      if (state.boundTo === "" && stored !== "" && stored.toLowerCase() === idAddress(accountId)) {
        state.boundTo = stored;
        announceBound(accountId);
      }
      return true;
    })
    .catch(() => (state.epoch === epoch ? false : state.restoring ?? false))
    .finally(() => {
      if (state.epoch === epoch) state.restoring = null;
    });
  state.restoring = restoring;
  return restoring;
}

async function ready(accountId: string): Promise<AccountCache | null> {
  const state = stateOf(accountId);
  if (state.loaded) return state;
  const ok = await (state.restoring ?? restore(accountId));
  return ok && state.loaded ? state : null;
}

/** One cache request with the current generation; a stale generation restores and retries once. */
async function request(accountId: string, method: string, params: Record<string, unknown>): Promise<any> {
  for (let attempt = 0; attempt < 2; attempt++) {
    // A restored cache is asked at once, in the caller's turn, so the read goes
    // out before the live listing that follows it (Qt asked the cache first).
    const current = stateOf(accountId);
    const state = current.loaded ? current : await ready(accountId);
    if (!state) throw new Error("cache_unavailable");
    const used = state.generation;
    try {
      return await call(method, { ...params, accountId, generation: used });
    } catch (error) {
      if (codeOf(error) !== "cache_stale_generation" || attempt > 0) throw error;
      // One restore for everyone who saw this generation go stale.
      if (state.restoring) await state.restoring;
      else if (state.generation === used) await restore(accountId);
    }
  }
  throw new Error("cache_stale_generation");
}

function hydrate(rows: unknown, now: Date): Summary[] {
  if (!Array.isArray(rows)) return [];
  const out: Summary[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const id = (raw as Record<string, unknown>).id;
    if (typeof id !== "string" || id === "") continue;
    out.push(hydrateSummary(raw as Record<string, unknown>, now));
  }
  return out;
}

/**
 * The cached page of `query` (and, with `search`, every cached row whose
 * sender, recipients, subject or snippet holds each word of it, inside the
 * provider's server-search scope: core's rules). Null when there is none or
 * the cache cannot answer: the live load is the answer then.
 */
export async function preview(accountId: string, query: string, limit: number, search: string): Promise<CachePreview | null> {
  // Bound already: asked in the caller's turn, ahead of the live listing.
  if (stateOf(accountId).boundTo === "" && !(await bound(accountId))) return null;
  try {
    const value: any = await request(accountId, "cache.queryGet", {
      query: String(query ?? ""), limit: Math.max(1, Math.floor(limit) || 1), search: String(search ?? ""), ttlMs: 0,
    });
    const summaries = hydrate(value?.summaries, new Date());
    if (summaries.length === 0) return null;
    const entry = value?.entry && typeof value.entry === "object"
      ? { estimate: Math.max(0, Number(value.entry.estimate) || 0), nextPageToken: String(value.entry.nextPageToken ?? "") }
      : null;
    return { summaries, entry };
  } catch {
    return null;
  }
}

/** A row as core stores it: plain fields with the date as `dateMs`, no presentation-only fields. */
function stored(row: Summary): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(row)) {
    if (field === "date" || field === "time" || field === "accountId" || field === "sourceId" || field === "sourceLabel") continue;
    if (value === undefined || typeof value === "function") continue;
    out[field] = value;
  }
  const date = row.date;
  if (date instanceof Date && isFinite(date.getTime())) out.dateMs = date.getTime();
  return out;
}

/** Writes the page the list showed for `query` (an empty answer included: an emptied mailbox must not paint old rows). */
export async function remember(accountId: string, query: string, limit: number, page: CachedPage): Promise<void> {
  if (stateOf(accountId).boundTo === "" && !(await bound(accountId))) return;
  try {
    await request(accountId, "cache.queryPut", {
      key: cacheKey(query, limit),
      page: { summaries: page.summaries.map(stored), estimate: Math.max(0, Number(page.estimate) || 0), nextPageToken: String(page.nextPageToken ?? "") },
    });
  } catch {
    // The cache is a convenience: the list on screen is still right.
  }
}

/** Drops every cached page holding one of `ids` (after an action changed them). */
export async function invalidate(accountId: string, ids: readonly string[]): Promise<boolean> {
  const clean = ids.map(String).filter((id) => id !== "");
  if (clean.length === 0) return false;
  try {
    await request(accountId, "cache.queryInvalidate", { ids: clean });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the account's cache is bound to its mailbox address: nothing is
 * painted from it or written to it before, so one address's summaries can
 * never show under another's. A bind in flight is waited for.
 */
async function bound(accountId: string): Promise<boolean> {
  const state = stateOf(accountId);
  if (state.boundTo !== "") return true;
  // A restore can bind provisionally (a confirmed address in the restored store).
  if (!state.loaded) await ready(accountId);
  if (state.boundTo !== "") return true;
  if (state.binding) await state.binding;
  return state.boundTo !== "";
}

/** Binds the cache to the mailbox address (the account owner calls it once the address is known): a different address empties it first. */
export async function bindAccount(accountId: string, email: string): Promise<boolean> {
  const address = String(email ?? "").trim();
  if (!accountId || address === "") return false;
  const state = stateOf(accountId);
  const before = state.boundTo;
  const binding = request(accountId, "cache.queryBind", { email: address })
    .then((value: any) => {
      // Core answers with the store's address: bound only when it is this one.
      const account = String(value?.store?.account ?? "");
      state.boundTo = account.toLowerCase() === address.toLowerCase() ? address : "";
      if (state.boundTo !== "") announceBound(accountId, before !== "" && before.toLowerCase() !== address.toLowerCase());
      return state.boundTo !== "";
    })
    .catch(() => {
      state.boundTo = "";
      return false;
    })
    .finally(() => {
      if (state.binding === binding) state.binding = null;
    });
  state.boundTo = "";
  state.binding = binding;
  return binding;
}

/** Empties the account's cache (signing out, removing the account). */
export async function clear(accountId: string): Promise<void> {
  stateOf(accountId).boundTo = "";
  try {
    await request(accountId, "cache.queryClear", {});
  } catch {
    // Nothing cached is shown without a restore anyway.
  }
}

/** Tests only: forget every generation. */
export function resetForTests() {
  accounts.clear();
}
