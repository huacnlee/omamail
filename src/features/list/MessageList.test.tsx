// The list end to end on a stand-in backend: rows from imap.list / imap.messages /
// message.summaries, keyboard movement, an optimistic archive with the exact
// request the Qt client sent, a failed change put back where it was, and a
// saved draft reopened from its row menu.
import { expect, open, test } from "nsh/test";

const ACCOUNT = { email: "jane@example.com", provider: "imap", label: "Jane" };
const NOW = Date.now();

function resource(n: number, extra: Record<string, unknown> = {}) {
  return {
    id: `${n}:INBOX`, subject: `Subject ${n}`, snippet: `Snippet ${n}`, dateMs: NOW - n * 60000,
    from: { name: `Sender ${n}`, email: `s${n}@example.com` }, unread: n === 1, labelIds: ["INBOX"], ...extra,
  };
}

// A draft saved earlier: the list knows its headers, the full read its text.
const DRAFT = {
  id: "7:Drafts", subject: "Saved subject", snippet: "Saved body", dateMs: NOW, isDraft: true, labelIds: ["DRAFT"],
  from: { name: "Jane", email: "jane@example.com" },
  to: [{ name: "Ann Lee", email: "ann@example.net" }], cc: [{ email: "bob@example.net" }],
  bodyText: "Saved body",
};

type Options = { failModify?: boolean; unread?: number[] };

function backend(options: Options = {}) {
  const calls: { method: string; params: any }[] = [];
  const rows = [1, 2, 3].map((n) => resource(n, options.unread ? { unread: options.unread.includes(n) } : {}));
  const modules = {
    "omamail-native": {
      "Backend.request": (method: string, params: any) => {
        calls.push({ method, params });
        switch (method) {
          case "accounts.read":
            return { result: { revision: "r1", registry: { version: 1, accounts: [ACCOUNT], activeId: "" } } };
          case "imap.list": {
            const listed = params.query === "folder:\\Drafts" ? [DRAFT] : rows;
            return { result: { page: { ids: listed.map((r) => r.id), nextPageToken: "", estimate: listed.length } } };
          }
          case "imap.messages":
            return { result: { messages: [...rows, DRAFT].filter((r) => params.ids.includes(r.id)) } };
          case "message.summaries":
            return { result: { summaries: params.messages } };
          case "message.prepare":
            return { result: { summary: params.message, body: { text: params.message.bodyText ?? "" }, attachments: [] } };
          case "imap.modify":
            return options.failModify ? { error: { code: -32000, message: "request_timed_out" } } : { result: {} };
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

async function start(options: Options = {}) {
  const fake = backend(options);
  const app = await open("../../../App.tsx", { modules: fake.modules, width: 1280, height: 820, platform: "linux" });
  await app.waitFor("text:Subject 3");
  return { app, calls: fake.calls };
}

test("rows show sender, subject and snippet in listing order", async () => {
  const { app, calls } = await start();
  expect(app.shows("text:Sender 1")).toBe(true);
  expect(app.shows("text:Snippet 2")).toBe(true);
  const list = calls.find((c) => c.method === "imap.list");
  expect(list?.params.query).toBe("folder:INBOX");
  expect(list?.params.progressive).toBe(false);
});

test("j opens the next row and e archives it with the Qt request", async () => {
  const { app, calls } = await start();
  await app.keyboard.press("j");
  await app.keyboard.press("e");
  await app.waitFor("text:Subject 1", { state: "gone" });
  await app.waitUntil(() => calls.some((c) => c.method === "imap.modify"));
  const modify = calls.find((c) => c.method === "imap.modify")!;
  expect(modify.params.ids).toEqual(["1:INBOX"]);
  expect(modify.params.removeLabelIds).toEqual(["INBOX"]);
  await app.waitFor("text:Archived");
});

test("the row's quick archive (pointer only) archives that row with the Qt request", async () => {
  const { app, calls } = await start();
  await app.hover("text:Subject 2");
  // A lane action, not a Tab stop (ui's roving-macos.test.tsx, "Tab from a row
  // goes to the next row, never to its quick actions"): named by the row's testID and the action.
  await app.press("id:message-row-1-archive");
  await app.waitFor("text:Subject 2", { state: "gone" });
  await app.waitUntil(() => calls.some((c) => c.method === "imap.modify"));
  const modify = calls.find((c) => c.method === "imap.modify")!;
  expect(modify.params.ids).toEqual(["2:INBOX"]);
  expect(modify.params.removeLabelIds).toEqual(["INBOX"]);
  expect(app.shows("text:Subject 1")).toBe(true);
});

test("a failed archive puts the row back and says why", async () => {
  const { app } = await start({ failModify: true });
  await app.keyboard.press("j");
  await app.keyboard.press("e");
  await app.waitFor("text:The mail server took too long to answer");
  await app.waitFor("text:Subject 1");
});

test("Undo puts an archived row back and sends the inverse", async () => {
  const { app, calls } = await start();
  await app.keyboard.press("j");
  await app.keyboard.press("e");
  await app.waitFor("text:Subject 1", { state: "gone" });
  await app.press("Undo");
  await app.waitFor("text:Subject 1");
  await app.waitUntil(() => calls.filter((c) => c.method === "imap.modify").length === 2);
  const inverse = calls.filter((c) => c.method === "imap.modify")[1];
  expect(inverse.params.addLabelIds).toEqual(["INBOX"]);
});

test("Ctrl+A checks every loaded row and the batch bar acts on all of them", async () => {
  const { app, calls } = await start();
  await app.keyboard.press("ctrl+a");
  await app.waitFor("text:3 selected");
  await app.press("Mark read");
  await app.waitUntil(() => calls.some((c) => c.method === "imap.modify"));
  const modify = calls.find((c) => c.method === "imap.modify")!;
  expect(modify.params.ids.length).toBe(3);
  expect(modify.params.removeLabelIds).toEqual(["UNREAD"]);
  await app.keyboard.press("escape");
  await app.waitFor("text:3 selected", { state: "gone" });
});

test("a right-click opens the row's menu", async () => {
  const { app } = await start();
  await app.rightClick("id:message-row-1");
  await app.waitFor("text:Reply all");
  expect(app.shows("text:Move to trash")).toBe(true);
});

test("Mark these read marks the loaded unread rows, as Qt's markAllRead did", async () => {
  const { app, calls } = await start({ unread: [1, 3] });
  await app.press("label:Menu");
  await app.press("Mark these read");
  await app.waitUntil(() => calls.some((c) => c.method === "imap.modify"));
  const modify = calls.filter((c) => c.method === "imap.modify");
  expect(modify.length).toBe(1);
  // Only the unread rows that are loaded: never a whole-mailbox request.
  expect(modify[0].params.ids.slice().sort()).toEqual(["1:INBOX", "3:INBOX"]);
  expect(modify[0].params.removeLabelIds).toEqual(["UNREAD"]);
  await app.waitFor("text:2 messages marked read");
});

test("the row menu is held by the message: Escape closes it and clears the target", async () => {
  const { app } = await start();
  await app.rightClick("id:message-row-1");
  await app.waitFor("text:Reply all");
  await app.keyboard.press("escape");
  await app.waitFor("text:Reply all", { state: "gone" });
  // Open again on another row: the menu follows that message.
  await app.rightClick("id:message-row-2");
  await app.waitFor("text:Reply all");
});

test("Continue editing opens a saved draft with what was written in it", async () => {
  const { app, calls } = await start();
  await app.press("id:mailbox-drafts");
  await app.waitFor("text:Saved subject");
  await app.rightClick("id:message-row-0");
  await app.press("text:Continue editing");
  await app.waitFor("id:compose");
  await app.waitUntil(() => app.value("id:compose-body") === "Saved body");
  expect(app.value("id:compose-subject")).toBe("Saved subject");
  // Saved again, it keeps its recipients and replaces the copy it came from.
  await app.type("id:compose-body", " and more");
  await app.press("id:compose-back");
  await app.press("id:compose-exit-save");
  await app.waitUntil(() => calls.some((c) => c.method === "message.compose"));
  const fields = calls.find((c) => c.method === "message.compose")!.params.fields;
  expect(fields.to).toBe("Ann Lee <ann@example.net>");
  expect(fields.cc).toBe("bob@example.net");
  expect(fields.subject).toBe("Saved subject");
  expect(fields.draftId).toBe("7:Drafts");
});
