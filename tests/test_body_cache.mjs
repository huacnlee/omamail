import assert from "node:assert/strict";

import { MAX_BODIES } from "../app/cache/Cache.js";
import {
  createBodyCache,
  MAX_RECORD_CHARS,
  MAX_STORE_CHARS,
} from "../app/application/body-cache.js";
import { createApplicationController } from "../app/application/controller.js";

// A store with the Web Storage surface, so the cache is exercised through the
// same three calls gpui's `localStorage` offers.
function storeWith(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

const ACCOUNT = "one@example.com";
const OTHER = "two@example.com";

// ------------------------------------------------------------------ the store

{
  const storage = storeWith();
  let ticks = 1000;
  const bodies = createBodyCache(storage, { now: () => (ticks += 1) });

  assert.equal(bodies.read(ACCOUNT, "m1"), null, "a message never opened misses");

  bodies.put(ACCOUNT, "m1", {
    text: "one",
    source: "html",
    html: "<p>one</p>",
    attachments: [{ filename: "a.txt", partId: "1" }],
    unsubscribe: { postUrl: "https://example.test/off" },
  });
  const hit = bodies.read(ACCOUNT, "m1");
  assert.equal(hit.text, "one");
  assert.equal(hit.html, "<p>one</p>");
  assert.equal(hit.attachments.length, 1);
  assert.equal(hit.unsubscribe.postUrl, "https://example.test/off");
  // Absent from a record written before either field existed, which the QML
  // treats as a hit with no card rather than a miss.
  assert.equal(hit.invite, null);

  // One account's cache is not another's, the way one account's directory is
  // not another's.
  assert.equal(bodies.read(OTHER, "m1"), null);
  bodies.put(OTHER, "m1", { text: "elsewhere" });
  assert.equal(bodies.read(ACCOUNT, "m1").text, "one");
  assert.equal(bodies.read(OTHER, "m1").text, "elsewhere");

  // An empty id has no file name and so has no record.
  bodies.put(ACCOUNT, "", { text: "nowhere" });
  assert.equal(bodies.read(ACCOUNT, ""), null);

  // A record from an older cache, or one that was truncated, does not parse.
  // That is a miss, not a crash — and a miss is what sends the reader to the
  // network to replace it.
  const key = [...storage.map.keys()].find(
    (name) => name.startsWith("omamail.body.v1:") && storage.map.get(name).includes("one"),
  );
  storage.map.set(key, '{"text":');
  assert.equal(bodies.read(ACCOUNT, "m1"), null, "an unreadable record is a miss");

  bodies.put(ACCOUNT, "m1", { text: "one" });
  bodies.clearAccount(ACCOUNT);
  assert.equal(bodies.read(ACCOUNT, "m1"), null);
  assert.deepEqual(
    [...storage.map.keys()].filter((name) => name.includes("account-one")),
    [],
    "clearing an account leaves none of its bodies behind",
  );
  assert.equal(bodies.read(OTHER, "m1").text, "elsewhere", "and leaves the other alone");
}

// Eviction is the QML's: least-recently-used, against a ceiling that is a plain
// count of records. A read is a use, so a message opened every morning outlives
// a hundred that arrived overnight.
{
  const storage = storeWith();
  let ticks = 0;
  const bodies = createBodyCache(storage, { now: () => (ticks += 1) });
  for (let index = 0; index < MAX_BODIES; index += 1)
    bodies.put(ACCOUNT, `m${index}`, { text: `body ${index}` });
  assert.equal(bodies.read(ACCOUNT, "m0").text, "body 0", "the cache holds MAX_BODIES");
  assert.equal(bodies.read(ACCOUNT, `m${MAX_BODIES - 1}`).text, `body ${MAX_BODIES - 1}`);

  // The oldest entry, used once — which is what a hit does — and then one more
  // message than the ceiling allows.
  bodies.touch(ACCOUNT, "m0");
  bodies.put(ACCOUNT, "overflow", { text: "newest" });
  assert.equal(bodies.read(ACCOUNT, "overflow").text, "newest");
  assert.equal(bodies.read(ACCOUNT, "m0").text, "body 0", "a touched entry survives");
  assert.equal(bodies.read(ACCOUNT, "m1"), null, "the least recently used one goes");
  assert.equal(bodies.read(ACCOUNT, "m2").text, "body 2", "and only that one");
}

// The ceiling this substrate needs and the QML's directory does not: every
// record shares one document, so a handful of enormous messages could grow it
// without ever reaching a thousand entries.
{
  const storage = storeWith();
  const bodies = createBodyCache(storage);
  bodies.put(ACCOUNT, "small", { text: "kept" });
  bodies.put(ACCOUNT, "huge", { text: "x".repeat(17 * 1024 * 1024) });
  assert.equal(bodies.read(ACCOUNT, "huge"), null, "one message larger than the cache is refused");
  assert.equal(bodies.read(ACCOUNT, "small").text, "kept", "and evicts nothing on its way out");
}

// ------------------------------------------------------------- the read path

const accounts = {
  version: 1,
  activeId: ACCOUNT,
  accounts: [{ id: ACCOUNT, email: ACCOUNT, provider: "gmail" }],
};

function resource(id, extra = {}) {
  return {
    id,
    labelIds: ["INBOX"],
    payload: {
      headers: [
        { name: "From", value: "Sender <sender@example.test>" },
        { name: "Subject", value: `Subject ${id}` },
      ],
      mimeType: "text/plain",
      // "text" in base64url. Synthetic: a fixture never carries real mail.
      body: { data: "dGV4dA" },
    },
    ...extra,
  };
}

function controllerWith(bodies, listed) {
  const effects = [];
  const completions = [];
  const controller = createApplicationController({
    storage: storeWith({ "omamail.accounts": JSON.stringify(accounts) }),
    bodies,
    execute(effect, complete) {
      effects.push(effect);
      completions.push(complete);
      return { cancel() {} };
    },
  });
  controller.start();
  completions.shift()({ status: 200, value: { messages: listed } });
  effects.length = 0;
  return { controller, effects, completions };
}

{
  const storage = storeWith();
  const bodies = createBodyCache(storage);
  const { controller, effects, completions } = controllerWith(bodies, [
    resource("m1"),
    resource("m2"),
  ]);

  // Never opened: the reader has to ask.
  controller.openMessage("m1");
  assert.equal(effects.length, 1);
  assert.equal(effects[0].scope, "object");
  completions.shift()({
    status: 200,
    value: { ...resource("m1"), id: "m1" },
  });
  assert.equal(controller.snapshot().detail.id, "m1");
  assert.equal(controller.snapshot().detail.body, "text");

  // Opened again. The body is on disk and a body does not change, so there is
  // nothing to ask for.
  controller.clearSelection();
  controller.openMessage("m1");
  assert.equal(effects.length, 1, "a second open issues no fetch");
  const cached = controller.snapshot().detail;
  assert.equal(cached.id, "m1");
  assert.equal(cached.body, "text");
  assert.equal(cached.subject, "Subject m1", "the row supplies the summary half");

  // The callback the response flow waits on is answered on a hit too, and
  // answered synchronously, so a reply opens without a round trip.
  let handed = null;
  controller.clearSelection();
  controller.openMessage("m1");
  controller.openCursor((detail) => {
    handed = detail;
  });
  assert.equal(handed?.body, "text");
  assert.equal(effects.length, 1);

  // And the plain "load this message's detail" path reaches the same record.
  // That path exists for the response flow, which wants the body to quote and
  // the reader left where it is — so a reply to a message that has been read
  // is composed without a round trip.
  let loaded = null;
  controller.loadDetail("m1", (message) => {
    loaded = message;
  });
  assert.equal(loaded?.body, "text");
  assert.equal(effects.length, 1, "loading a cached detail issues no fetch");

  // A message with no record of its own still fetches.
  controller.clearSelection();
  controller.openMessage("m2");
  assert.equal(effects.length, 2, "an absent entry fetches");

  // And so does one whose record has been evicted.
  completions.shift()({ status: 200, value: { ...resource("m2"), id: "m2" } });
  bodies.clearAccount(ACCOUNT);
  controller.clearSelection();
  controller.openMessage("m2");
  assert.equal(effects.length, 3, "an evicted entry fetches");
}

// A draft is the one message that is not a fetched body: it is what somebody
// was typing, and it changes. It is never cached and never served from cache,
// however many times it is opened.
{
  const bodies = createBodyCache(storeWith());
  const { controller, effects, completions } = controllerWith(bodies, [
    resource("d1", { draftId: "draft-1", labelIds: ["DRAFT"] }),
  ]);
  controller.openMessage("d1");
  completions.shift()({
    status: 200,
    value: { ...resource("d1", { draftId: "draft-1", labelIds: ["DRAFT"] }) },
  });
  assert.equal(bodies.read(ACCOUNT, "d1"), null, "a draft body is never stored");
  controller.clearSelection();
  controller.openMessage("d1");
  assert.equal(effects.length, 2, "a draft is read again every time it is opened");
}

// A controller with no body cache at all behaves exactly as it did before one
// existed: every open is a fetch.
{
  const { controller, effects } = controllerWith(undefined, [resource("m1")]);
  controller.openMessage("m1");
  controller.clearSelection();
  controller.openMessage("m1");
  assert.equal(effects.length, 2);
}


// The ceilings are the host's, and the host refuses rather than evicting.
//
// `crates/shell/src/storage.rs` caps the whole store at 8 MiB, one value at
// 1 MiB and the key count at 4096, and `Storage::set` returns an error past any
// of them. A cache sized past those would not become slow — it would stop the
// client saving a setting. So the bodies take a slice and leave the rest.
{
  const HOST_STORE_BYTES = 8 * 1024 * 1024;
  const HOST_VALUE_BYTES = 1024 * 1024;
  const HOST_KEYS = 4096;
  assert.ok(
    MAX_STORE_CHARS < HOST_STORE_BYTES,
    "the body cache alone must not claim the whole store",
  );
  assert.ok(
    MAX_RECORD_CHARS < HOST_VALUE_BYTES,
    "a single record must fit the host's per-value limit",
  );
  // One key per body plus one index key per account, against the key ceiling.
  assert.ok(
    MAX_BODIES + 64 < HOST_KEYS,
    "the body keys must leave room for accounts, settings and the list cache",
  );
}

console.log("body cache tests passed");
