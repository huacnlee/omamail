// The list and the query cache on a stand-in backend (synthetic rows, no real
// account or cache file): cache-first paint replaced by the live answer and
// written back, a Chinese search showing cached matches before the server
// answers, a stale generation restored and retried, and an archive dropping
// the cached pages that held the row. Port of MailAccount.qml's cache use.
import { expect, open, test } from "nsh/test";

const ACCOUNT = { email: "jane@example.com", provider: "imap", label: "Jane" };
const NOW = Date.now();

function resource(id: string, subject: string, minutes: number, extra: Record<string, unknown> = {}) {
  return {
    id, subject, snippet: "Snippet of " + subject, dateMs: NOW - minutes * 60000,
    from: { name: "Sender " + id, email: "s@example.com" }, unread: false, labelIds: ["INBOX"], ...extra,
  };
}

const LIVE = [resource("1:INBOX", "Live one", 1), resource("2:INBOX", "Live two", 2)];

interface Options {
  /** What cache.queryGet answers with: rows ("summaries") and the view's entry. */
  cached?: { summaries: unknown[]; entry?: unknown } | ((params: any) => { summaries: unknown[]; entry?: unknown } | null);
  /** While closed, the live listing waits for it to open before it answers. */
  gate?: Gate;
  /** cache.queryBind fails: the cache stays unbound. */
  bindFails?: boolean;
  /** The first cache.queryGet answers with a stale generation. */
  staleFirst?: boolean;
  /** The address core's restored store holds (the server confirmed it before); "" for none. */
  restoredAccount?: string;
  /** The live listing fails, as offline. */
  offline?: boolean;
  /** A Gmail mailbox whose gmail.profile reports `profile`, and whose live listing fails. */
  gmail?: { profile: string };
}


function backend(options: Options = {}) {
  const calls: { method: string; params: any }[] = [];
  let generation = 0;
  let staled = false;
  // Core's store: its confirmed address, and whether a rebind emptied it.
  let storeAccount = options.restoredAccount ?? "";
  let emptied = false;
  const modules = {
    "omamail-native": {
      "Backend.request": async (method: string, params: any) => {
        calls.push({ method, params: JSON.parse(JSON.stringify(params ?? {})) });
        if (method.startsWith("cache.query") && method !== "cache.queryRestore") {
          if (options.staleFirst && !staled && method === "cache.queryGet") {
            staled = true;
            return { error: { code: -32000, message: "cache_stale_generation" } };
          }
          if (params.generation !== generation) return { error: { code: -32000, message: "cache_stale_generation" } };
        }
        switch (method) {
          case "accounts.read":
            return { result: { revision: "r1", registry: { version: 1, accounts: [options.gmail ? { ...ACCOUNT, provider: "gmail" } : ACCOUNT], activeId: "" } } };
          case "cache.queryRestore":
            generation += 1;
            return { result: { generation, store: { version: 2, account: storeAccount, profile: null, labels: [], session: null } } };
          case "cache.queryGet": {
            if (emptied) return { result: { key: "", entry: null, summaries: [], local: [], stale: true } };
            const answer = typeof options.cached === "function" ? options.cached(params) : options.cached;
            return { result: { key: "", entry: answer?.entry ?? null, summaries: answer?.summaries ?? [], local: [], stale: true } };
          }
          case "cache.queryBind":
            if (options.bindFails) return { error: { code: -32000, message: "cache_invalid_input" } };
            // accounts binds each mailbox to its server's address (accounts-cache.ts);
            // as core, another address empties the store first.
            if (storeAccount !== "" && storeAccount.toLowerCase() !== String(params.email).toLowerCase()) emptied = true;
            storeAccount = params.email;
            return { result: { store: { version: 2, account: params.email, profile: null, labels: [], session: null } } };
          case "cache.queryPut":
          case "cache.queryInvalidate":
            return { result: {} };
          case "providers.resolve":
            return { result: { value: "text:" + String(params.search ?? "") } };
          // The stand-in answers one request at a time, so nothing here is held:
          // whichever comes first, the cache paint or the rebind, the outcome is checked.
          case "gmail.profile":
            return { result: { email: options.gmail!.profile } };
          case "gmail.list":
            // Offline: only what the list kept stays on screen.
            return { error: { code: -32000, message: "gmail_timeout" } };
          case "imap.list":
            if (options.offline) return { error: { code: -32000, message: "request_timed_out" } };
            if (options.gate) await options.gate.passed();
            return { result: { page: { ids: LIVE.map((r) => r.id), nextPageToken: "", estimate: LIVE.length } } };
          case "imap.messages":
            return { result: { messages: LIVE.filter((r) => params.ids.includes(r.id)) } };
          case "message.summaries":
            return { result: { summaries: params.messages } };
          case "imap.modify":
            return { result: {} };
          default:
            return { result: null };
        }
      },
      "Backend.nextEvent": () => null,
      "Backend.shutdown": () => undefined,
      "Backend.os": () => "linux",
      "Backend.readConfig": () => null,
      "Backend.writeConfig": () => undefined,
    },
  };
  return { modules, calls };
}

// A step resolves once the app is quiet, and a held listing is not quiet, so
// the test cannot look between the cache's paint and the live answer. The
// held listing looks instead: once armed, it answers only when `until` holds
// (what the app shows), however long that takes under load. No wall-clock
// cap: if the paint never comes, the test times out and fails.
interface Gate { arm(until: () => boolean): void; saw: boolean; passed(): Promise<void> }
function gate(): Gate {
  let until: (() => boolean) | null = null;
  const self: Gate = {
    saw: false,
    arm(check) {
      until = check;
      self.saw = false;
    },
    async passed() {
      const check = until;
      until = null;
      if (!check) return;
      while (!check()) await new Promise((resolve) => setTimeout(resolve, 10));
      self.saw = true;
    },
  };
  return self;
}

async function start(options: Options = {}) {
  const fake = backend(options);
  const app = await open("../../../App.tsx", { modules: fake.modules, width: 1280, height: 820, platform: "linux" });
  return { app, calls: fake.calls };
}

test("a view paints from the cache, then the live answer replaces it and is written back", async () => {
  const live = gate();
  const { app, calls } = await start({
    cached: { summaries: [resource("9:INBOX", "Cached from last visit", 30)], entry: { estimate: 7, nextPageToken: "old" } },
    gate: live,
  });
  await app.waitFor("text:Live one");
  // Away and back: the inbox paints from the cache while its live load is held.
  await app.press("Unread");
  const before = calls.length;
  live.arm(() => app.shows("text:Cached from last visit") && !app.shows("text:Live one"));
  await app.press("Inbox");
  expect(live.saw).toBe(true);
  const get = calls.slice(before).find((c) => c.method === "cache.queryGet")!;
  expect(get.params.query).toBe("folder:INBOX");
  expect(get.params.limit).toBe(50);
  expect(get.params.search).toBe("");
  expect(get.params.generation).toBe(1);

  await app.waitFor("text:Live one");
  await app.waitFor("text:Cached from last visit", { state: "gone" });
  await app.waitUntil(() => calls.slice(before).some((c) => c.method === "cache.queryPut"));
  const put = calls.slice(before).filter((c) => c.method === "cache.queryPut").at(-1)!;
  expect(put.params.key).toBe("folder:INBOX|50");
  expect(put.params.page.summaries.map((r: any) => r.id)).toEqual(["1:INBOX", "2:INBOX"]);
  // Stored as plain fields: the date as dateMs, nothing drawn-only.
  const first = put.params.page.summaries[0];
  expect(first.dateMs).toBe(LIVE[0].dateMs);
  expect("time" in first).toBe(false);
  expect("date" in first).toBe(false);
  expect(put.params.page.nextPageToken).toBe("");
});

test("a Chinese search shows cached matches before the server answers", async () => {
  const live = gate();
  const { app, calls } = await start({
    gate: live,
    cached: (params) => (params.search === "评审"
      ? { summaries: [resource("7:INBOX", "季度评审", 90, { snippet: "请在周四之前提交材料" })] }
      : null),
  });
  await app.waitFor("text:Live one");
  await app.type("label:Search mail", "评审");
  live.arm(() => app.shows("text:季度评审") && app.shows("text:请在周四之前提交材料"));
  await app.keyboard.press("Enter");
  expect(live.saw).toBe(true);
  const search = calls.filter((c) => c.method === "cache.queryGet").find((c) => c.params.search === "评审")!;
  expect(search.params.query).toBe("text:评审");
  // The server's answer is the result: the preview does not survive it.
  await app.waitFor("text:Live one");
  await app.waitFor("text:季度评审", { state: "gone" });
});

test("a stale generation restores the cache and tries once more", async () => {
  const { app, calls } = await start({
    staleFirst: true,
    cached: { summaries: [resource("9:INBOX", "Cached after a restore", 30)] },
  });
  // The cached row paints and the live answer follows; the cache was asked twice.
  await app.waitFor("text:Live one");
  const restores = calls.filter((c) => c.method === "cache.queryRestore");
  expect(restores.length).toBe(2);
  const gets = calls.filter((c) => c.method === "cache.queryGet");
  expect(gets[0].params.generation).toBe(1);
  expect(gets.length).toBe(2);
  expect(gets[1].params.generation).toBe(2);
  // The bind went out with a live generation too.
  expect(calls.some((c) => c.method === "cache.queryBind" && c.params.email === "jane@example.com")).toBe(true);
});

test("an archive drops the cached pages holding the row and keeps the list as shown", async () => {
  const { app, calls } = await start();
  await app.waitFor("text:Live two");
  await app.keyboard.press("j");
  await app.keyboard.press("e");
  await app.waitFor("text:Live one", { state: "gone" });
  await app.waitUntil(() => calls.some((c) => c.method === "cache.queryInvalidate"));
  const invalidate = calls.find((c) => c.method === "cache.queryInvalidate")!;
  expect(invalidate.params.ids).toEqual(["1:INBOX"]);
  // After the invalidation, the list as it now stands is written back.
  const index = calls.indexOf(invalidate);
  await app.waitUntil(() => calls.slice(index).some((c) => c.method === "cache.queryPut"));
  const put = calls.slice(index).find((c) => c.method === "cache.queryPut")!;
  expect(put.params.page.summaries.map((r: any) => r.id)).toEqual(["2:INBOX"]);
});

test("an unbound account paints nothing from the cache and writes nothing to it", async () => {
  const { app, calls } = await start({
    bindFails: true,
    cached: { summaries: [resource("9:INBOX", "Cached for another address", 30)] },
  });
  await app.waitFor("text:Live one");
  await app.press("Unread");
  await app.press("Inbox");
  await app.waitFor("text:Live two");
  expect(calls.some((c) => c.method === "cache.queryBind")).toBe(true);
  expect(app.shows("text:Cached for another address")).toBe(false);
  // The forbidden effects did not happen: no read of a cached page, no write.
  expect(calls.some((c) => c.method === "cache.queryGet")).toBe(false);
  expect(calls.some((c) => c.method === "cache.queryPut")).toBe(false);
});

test("offline, a mailbox whose address the server confirmed before paints its cache", async () => {
  const { app, calls } = await start({
    restoredAccount: "jane@example.com",
    bindFails: true,
    offline: true,
    cached: { summaries: [resource("9:INBOX", "Cached while offline", 30)] },
  });
  await app.waitFor("text:Cached while offline");
  await app.waitFor("text:The mail server took too long to answer");
  expect(calls.some((c) => c.method === "cache.queryGet")).toBe(true);
});

test("the server reporting another address never leaves the old address's rows on screen", async () => {
  const { app, calls } = await start({
    restoredAccount: "jane@example.com",
    gmail: { profile: "jane.doe@example.com" },
    cached: { summaries: [resource("9:INBOX", "Painted for the old address", 30)] },
  });
  // Offline after the rebind: the cached rows would stay under the error, but
  // core emptied the store for the new address and the list dropped its paint.
  await app.waitFor("text:Gmail did not answer in time");
  expect(app.shows("text:Painted for the old address")).toBe(false);
  expect(calls.some((c) => c.method === "cache.queryBind" && c.params.email === "jane.doe@example.com")).toBe(true);
});
