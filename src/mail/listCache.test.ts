// listCache's identity rules on a stand-in for core's query cache (synthetic
// rows and addresses; no cache file): a restored, server-confirmed address
// counts as bound at once; an empty or foreign one does not; a bind to a
// different address replaces the binding and core's emptied store paints nothing.
import { expect, test } from "nsh/test";
import { usePreviewBackend } from "../backend/client";
import * as listCache from "./listCache";

const ID = "imap:jane@example.com";

function core(options: { restoredAccount: string; bindFails?: boolean }) {
  const calls: { method: string; params: any }[] = [];
  let generation = 0;
  let account = options.restoredAccount;
  let rows: unknown[] = [{ id: "9:INBOX", subject: "Cached row", snippet: "", dateMs: 1_700_000_000_000 }];
  usePreviewBackend((method, params) => {
    calls.push({ method, params });
    if (method === "cache.queryRestore") {
      generation += 1;
      return { generation, store: { version: 2, account, profile: null, labels: [], session: null } };
    }
    if (params.generation !== generation) throw new Error("cache_stale_generation");
    switch (method) {
      case "cache.queryBind":
        if (options.bindFails) throw new Error("cache_invalid_input");
        // As core: another address empties the store first.
        if (account !== "" && account.toLowerCase() !== String(params.email).toLowerCase()) rows = [];
        account = params.email;
        return { store: { version: 2, account, profile: null, labels: [], session: null } };
      case "cache.queryGet":
        return { key: "", entry: null, summaries: rows, local: [], stale: true };
      case "cache.queryPut":
        return {};
      default:
        throw new Error("method_not_found");
    }
  });
  return calls;
}

test("a restored, server-confirmed address paints at once, with no bind (offline)", async () => {
  listCache.resetForTests();
  const calls = core({ restoredAccount: "Jane@Example.com", bindFails: true });
  const heard: string[] = [];
  const stop = listCache.onBound((id, replaced) => heard.push(id + (replaced ? " replaced" : "")));
  const shown = await listCache.preview(ID, "folder:INBOX", 50, "");
  stop();
  expect(shown?.summaries.map((r) => r.subject)).toEqual(["Cached row"]);
  expect(heard).toEqual([ID]);
  expect(calls.some((c) => c.method === "cache.queryBind")).toBe(false);
});

test("an empty restored address stays unbound: nothing is read or written", async () => {
  listCache.resetForTests();
  const calls = core({ restoredAccount: "" });
  expect(await listCache.preview(ID, "folder:INBOX", 50, "")).toBe(null);
  await listCache.remember(ID, "folder:INBOX", 50, { summaries: [], estimate: 0, nextPageToken: "" });
  expect(calls.some((c) => c.method === "cache.queryGet" || c.method === "cache.queryPut")).toBe(false);
});

test("a restored address that is not the id's own is not trusted", async () => {
  listCache.resetForTests();
  const calls = core({ restoredAccount: "someone@example.org" });
  expect(await listCache.preview(ID, "folder:INBOX", 50, "")).toBe(null);
  expect(calls.some((c) => c.method === "cache.queryGet")).toBe(false);
});

test("the server reporting another address rebinds: the old rows are gone", async () => {
  listCache.resetForTests();
  core({ restoredAccount: "jane@example.com" });
  expect((await listCache.preview(ID, "folder:INBOX", 50, ""))?.summaries.length).toBe(1);
  const heard: string[] = [];
  const stop = listCache.onBound((id, replaced) => heard.push(id + (replaced ? " replaced" : "")));
  expect(await listCache.bindAccount(ID, "jane.doe@example.com")).toBe(true);
  stop();
  expect(heard).toEqual([ID + " replaced"]);
  expect(await listCache.preview(ID, "folder:INBOX", 50, "")).toBe(null);
});
