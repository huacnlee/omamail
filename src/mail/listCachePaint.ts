// What a list view does with its cached preview, as pure rules (the list
// store applies them): when its account's cache becomes bound, and how a
// cached page lands on what the view shows.
import { sameSummaries, type Summary } from "./listModel";
import type { CachePreview } from "./listCache";

/** Where a view's load stands when its account's cache becomes bound. */
export interface LoadState {
  /** A newer load of this view started: this one no longer touches it. */
  stale: boolean;
  /** The live answer arrived: it is newer than any cache. */
  live: boolean;
}

/**
 * - `ignore`: the view is stale or has its live answer.
 * - `paint`: read the cache and paint what it holds.
 * - `drop-then-paint`: the cache was bound to another address; what the view
 *   painted from it was that identity's, so it goes before the cache is read again.
 */
export type BindDecision = "ignore" | "paint" | "drop-then-paint";

export function onBindDecision(load: LoadState, replaced: boolean): BindDecision {
  if (load.stale || load.live) return "ignore";
  return replaced ? "drop-then-paint" : "paint";
}

/** The view's fields a cached page or a drop sets. */
export interface PaintedFields {
  rows: Summary[];
  estimate: number;
  nextPageToken: string;
  query: string;
  loaded: boolean;
  error: string;
}

/** What a drop leaves: nothing painted, nothing loaded; an error stays in view. */
export function droppedFields(): Omit<PaintedFields, "query" | "error"> {
  return { rows: [], estimate: 0, nextPageToken: "", loaded: false };
}

/**
 * A cached page over what the view shows. After a failed live load the error
 * stays in view (offline, the rows sit under it), and the cached continuation
 * is dropped: it was never revalidated, so paging with it could skip rows.
 */
export function cachedFields(
  current: { rows: Summary[]; error: string },
  cached: CachePreview,
  query: string,
  failed: boolean,
): PaintedFields {
  return {
    rows: sameSummaries(current.rows, cached.summaries) ? current.rows : cached.summaries,
    estimate: cached.entry ? Math.max(cached.entry.estimate, cached.summaries.length) : cached.summaries.length,
    nextPageToken: failed ? "" : cached.entry?.nextPageToken ?? "",
    query,
    loaded: true,
    error: failed ? current.error : "",
  };
}
