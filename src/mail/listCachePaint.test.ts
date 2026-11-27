// The list's rules for its cached preview when the account's cache becomes
// bound, replayed on a synthetic view (no backend, no app).
import { expect, test } from "nsh/test";
import type { CachePreview } from "./listCache";
import { cachedFields, droppedFields, onBindDecision, type BindDecision, type LoadState } from "./listCachePaint";
import type { Summary } from "./listModel";

function row(id: string, subject: string): Summary {
  return { id, subject, snippet: "", dateMs: 1_700_000_000_000 } as unknown as Summary;
}

interface View {
  rows: Summary[];
  estimate: number;
  nextPageToken: string;
  query: string;
  loaded: boolean;
  error: string;
}

/** What the store does with a bind: decide, maybe drop, maybe paint what the cache now holds. */
function bind(view: View, load: LoadState, replaced: boolean, cacheNow: CachePreview | null, failed = false): { view: View; decision: BindDecision } {
  const decision = onBindDecision(load, replaced);
  if (decision === "ignore") return { view, decision };
  let next = view;
  if (decision === "drop-then-paint") next = { ...next, ...droppedFields() };
  if (cacheNow) next = { ...next, ...cachedFields(next, cacheNow, view.query, failed) };
  return { view: next, decision };
}

const OLD: View = { rows: [row("9:INBOX", "Painted for the old address")], estimate: 1, nextPageToken: "t1", query: "folder:INBOX", loaded: true, error: "" };

test("replaced while the live answer is pending: the old identity's rows are dropped", () => {
  // Core emptied the store for the new address, so the repaint finds nothing.
  const { view, decision } = bind(OLD, { stale: false, live: false }, true, null);
  expect(decision).toBe("drop-then-paint");
  expect(view.rows).toEqual([]);
  expect(view.loaded).toBe(false);
  expect(view.estimate).toBe(0);
  expect(view.nextPageToken).toBe("");
});

test("replaced after the live answer: ignored, the live rows stay", () => {
  const live: View = { ...OLD, rows: [row("1:INBOX", "Live one")] };
  const { view, decision } = bind(live, { stale: false, live: true }, true, null);
  expect(decision).toBe("ignore");
  expect(view).toBe(live);
});

test("a stale load ignores any bind", () => {
  expect(onBindDecision({ stale: true, live: false }, true)).toBe("ignore");
  expect(onBindDecision({ stale: true, live: false }, false)).toBe("ignore");
});

test("bound after a failed live load: the cache paints under the error, with no continuation", () => {
  const failedView: View = { rows: [], estimate: 0, nextPageToken: "", query: "folder:INBOX", loaded: false, error: "The mail server took too long to answer" };
  const cached: CachePreview = { summaries: [row("9:INBOX", "Cached while offline")], entry: { estimate: 40, nextPageToken: "t9" } };
  const { view, decision } = bind(failedView, { stale: false, live: false }, false, cached, true);
  expect(decision).toBe("paint");
  expect(view.rows.map((r) => r.subject)).toEqual(["Cached while offline"]);
  expect(view.error).toBe("The mail server took too long to answer");
  expect(view.nextPageToken).toBe("");
  expect(view.estimate).toBe(40);
  expect(view.loaded).toBe(true);
});

test("a replaced bind after a failure drops the old rows but keeps the error", () => {
  const failedOld: View = { ...OLD, error: "Gmail did not answer in time" };
  const { view } = bind(failedOld, { stale: false, live: false }, true, null, true);
  expect(view.rows).toEqual([]);
  expect(view.error).toBe("Gmail did not answer in time");
});

test("bound before any answer: the cached page and its continuation paint", () => {
  const empty: View = { rows: [], estimate: 0, nextPageToken: "", query: "folder:INBOX", loaded: false, error: "" };
  const cached: CachePreview = { summaries: [row("9:INBOX", "Cached")], entry: { estimate: 3, nextPageToken: "t9" } };
  const { view } = bind(empty, { stale: false, live: false }, false, cached);
  expect(view.rows.length).toBe(1);
  expect(view.nextPageToken).toBe("t9");
  expect(view.error).toBe("");
});
