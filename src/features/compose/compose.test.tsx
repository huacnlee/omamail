// Compose on a stand-in backend: the send checks, the draft going to the
// outbox of the mailbox it belongs to, undo, leaving with Save draft, and
// recovery. Ports of tst_compose_send.qml, tst_send_queue.qml,
// tst_compose_recovery.qml and tst_mailto.qml where they apply.
import { expect, open, test } from "nsh/test";

type Call = { method: string; params: any };

const ACCOUNTS = [
  { id: "jane@example.com", email: "jane@example.com", provider: "gmail", label: "Jane", senderName: "Jane Doe" },
  { id: "acct-b", email: "sam@example.org", provider: "imap", label: "Sam" },
];

function backend(calls: Call[], recovery: { record: any } = { record: { version: 1, active: false } }) {
  let revision = 1;
  const entries: any[] = [];
  return {
    "omamail-native": {
      "Backend.request": (method: string, params: any) => {
        calls.push({ method, params });
        if (method === "accounts.read") return { result: { revision: "r1", registry: { version: 1, accounts: ACCOUNTS, activeId: "jane@example.com" } } };
        if (method === "account.identities") return { result: { identities: [] } };
        if (method === "message.composeText") return { result: { body: "\n\n-- \nJane", quote: "", replySubject: "" } };
        if (method === "message.compose") return { result: { raw: "UkFX", draftId: params.fields.draftId || "" } };
        if (method === "compose.recoveryRead") return { result: { revision: String(revision), record: recovery.record } };
        if (method === "compose.recoverySave") {
          recovery.record = params.record;
          revision += 1;
          return { result: { revision: String(revision), record: params.record } };
        }
        if (method === "outbox.enqueue") {
          const entry = { id: params.sendId, state: "queued", queuedAt: Date.now(), dueAt: Date.now() + 10_000 };
          entries.push(entry);
          return { result: { snapshot: { accountId: params.accountId, entries: [entry] } } };
        }
        if (method === "outbox.undo") return { result: { snapshot: { accountId: params.accountId, entries: [{ id: params.sendId, state: "cancelled" }] }, id: params.sendId } };
        if (method === "outbox.snapshot") return { result: { accountId: params.accountId, entries: [] } };
        if (method === "contacts.suggest") return { result: [{ name: "Ann Lee", email: "ann@example.net" }] };
        if (method === "gmail.saveDraft") return { result: { id: "d1" } };
        return { result: null };
      },
      "Backend.nextEvent": () => null,
      "Backend.shutdown": () => undefined,
      "Backend.os": () => "linux",
      "Backend.readConfig": () => null,
      "Backend.writeConfig": () => undefined,
    },
  };
}

async function start(recovery?: { record: any }) {
  const calls: Call[] = [];
  const app = await open("./fixtures/ComposeApp.tsx", { modules: backend(calls, recovery), width: 1000, height: 760, platform: "linux" });
  await app.waitFor("id:new-message");
  return { app, calls };
}

function named(calls: Call[], method: string) {
  return calls.filter((c) => c.method === method);
}

test("Send refuses a draft without a recipient", async () => {
  const { app, calls } = await start();
  await app.press("id:new-message");
  await app.waitFor("id:compose");
  await app.type("id:compose-body", "Hello there");
  await app.press("id:compose-send");
  await app.waitFor("Add a recipient first");
  expect(named(calls, "outbox.enqueue").length).toBe(0);
});

test("A new message puts the keyboard in To", async () => {
  const { app } = await start();
  await app.press("id:new-message");
  await app.waitFor("id:compose");
  for (const key of ["q", "z", "x", "j"]) await app.keyboard.press(key);
  await app.waitFor("qzxj", { timeout: 2000 });
});

test("Send queues the draft in its own mailbox's outbox, with the undo window", async () => {
  const { app, calls } = await start();
  await app.press("id:new-message");
  await app.waitFor("id:compose");
  await app.type("id:compose-to", "ann@example.net,");
  await app.type("id:compose-subject", "Plans");
  await app.type("id:compose-body", "See you at noon");
  await app.press("id:compose-send");
  await app.waitFor("Undo", { timeout: 3000 });
  const composed = named(calls, "message.compose");
  expect(composed.length).toBe(1);
  expect(composed[0]!.params.fields.to).toBe("ann@example.net");
  expect(composed[0]!.params.fields.from).toBe("jane@example.com");
  const queued = named(calls, "outbox.enqueue");
  expect(queued.length).toBe(1);
  expect(queued[0]!.params.accountId).toBe("jane@example.com");
  expect(String(queued[0]!.params.sendId).startsWith("send-")).toBe(true);
  // The editor closed; the draft waits in recovery under its send id.
  expect(app.shows("id:compose")).toBe(false);
});

test("Undo brings the sent draft back", async () => {
  const { app, calls } = await start();
  await app.press("id:new-message");
  await app.waitFor("id:compose");
  await app.type("id:compose-to", "ann@example.net,");
  await app.type("id:compose-body", "Undo me");
  await app.press("id:compose-send");
  await app.waitFor("Undo", { timeout: 3000 });
  await app.press("Undo");
  await app.waitFor("id:compose");
  expect(named(calls, "outbox.undo").length).toBe(1);
  expect(named(calls, "outbox.undo")[0]!.params.accountId).toBe("jane@example.com");
});

test("Back on a changed draft asks; Save draft saves through its mailbox", async () => {
  const { app, calls } = await start();
  await app.press("id:new-message");
  await app.waitFor("id:compose");
  await app.type("id:compose-subject", "Later");
  await app.press("id:compose-back");
  await app.waitFor("Save this draft?");
  await app.press("id:compose-exit-save");
  await app.waitFor("Draft saved", { timeout: 3000 });
  const saved = named(calls, "gmail.saveDraft");
  expect(saved.length).toBe(1);
  expect(saved[0]!.params.accountId).toBe("jane@example.com");
});

test("A recovered draft reopens after the accounts load", async () => {
  const draft = { draftKey: "k1", mode: "new", accountId: "jane@example.com", to: "ann@example.net, ", subject: "Recovered", body: "Kept", userModified: true };
  const { app } = await start({ record: { version: 1, active: true, returnView: "list", draft, parked: [] } });
  await app.waitFor("id:compose", { timeout: 4000 });
  await app.waitFor("Recovered");
});

test("A recovered draft of a missing mailbox says so and does not open", async () => {
  const draft = { draftKey: "k2", mode: "new", accountId: "gone", subject: "Orphan", body: "x", userModified: true };
  const { app } = await start({ record: { version: 1, active: true, returnView: "list", draft, parked: [] } });
  await app.waitFor("This draft belongs to an unavailable account.", { timeout: 4000 });
  expect(app.shows("id:compose")).toBe(false);
});
