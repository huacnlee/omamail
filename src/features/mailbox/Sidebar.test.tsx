// The sidebar on a stand-in backend: mailboxes and labels as the provider
// reports them, folding, opening a label, the label menu's requests, the
// account switcher and the Ctrl digits. Ports of tst_sidebar_fold.qml,
// tst_account_switcher.qml and tst_label_ownership.qml where they apply.
import { expect, open, test } from "nsh/test";

type Acct = { email: string; provider: string; label?: string };

const LABELS = [
  { id: "INBOX", name: "Inbox", rawName: "INBOX", system: true, unread: 3 },
  { id: "Label_2", name: "Work", rawName: "Work", unread: 0 },
  { id: "Label_3", name: "Work/Invoices", rawName: "Work/Invoices", unread: 2 },
  { id: "Label_1", name: "Bills", rawName: "Bills", unread: 0 },
];

function backend(accounts: Acct[], calls: { method: string; params: any }[], files: Record<string, string> = {}) {
  return {
    "omamail-native": {
      "Backend.request": (method: string, params: any) => {
        calls.push({ method, params });
        if (method === "accounts.read") return { result: { revision: "r1", registry: { version: 1, accounts, activeId: "" } } };
        if (method === "gmail.labels") return { result: LABELS };
        if (method === "jmap.labels")
          return { result: { data: [], state: { mailboxes: [
            { id: "a", name: "Inbox", parentId: null, role: "inbox" },
            { id: "t", name: "Trash", parentId: null, role: "trash" },
          ] } } };
        if (method === "m365.verify") return { result: { ok: true, roles: { inbox: {}, sent: {}, drafts: {}, trash: {}, junk: {}, archive: null } } };
        return { result: null };
      },
      "Backend.nextEvent": () => null,
      "Backend.shutdown": () => undefined,
      "Backend.os": () => "linux",
      "Backend.readConfig": (name: string) => files[name] ?? null,
      "Backend.writeConfig": (name: string, text: string) => {
        files[name] = text;
      },
    },
  };
}

const JANE: Acct[] = [{ email: "jane@example.com", provider: "gmail", label: "Jane" }];
const TWO: Acct[] = [...JANE, { email: "sam@example.org", provider: "imap", label: "Sam" }];

async function start(accounts: Acct[], storage: Record<string, string> = {}) {
  const calls: { method: string; params: any }[] = [];
  const files: Record<string, string> = {};
  const app = await open("./fixtures/SidebarApp.tsx", { modules: backend(accounts, calls, files), width: 1280, height: 820, storage, platform: "linux" });
  await app.waitFor("id:mailbox-sidebar");
  return { app, calls, files };
}

test("the provider's mailboxes come first, then its labels A to Z, nested", async () => {
  const { app } = await start(JANE);
  await app.waitFor("id:label-Work/Invoices");
  for (const id of ["mailbox-inbox", "mailbox-unread", "mailbox-starred", "mailbox-sent", "label-Bills", "label-Work"]) {
    expect(app.shows(`id:${id}`)).toBe(true);
  }
  // A system label is never a rail row.
  expect(app.shows("id:label-Inbox")).toBe(false);
  expect(app.accessibility("id:mailbox-inbox")?.selected).toBe(true);
});

test("the chevron folds without opening, and the fold is stored in window.json", async () => {
  const { app, files } = await start(JANE);
  await app.waitFor("id:label-Work/Invoices");
  expect(app.accessibility("id:fold-Work")?.label).toBe("Fold Work");
  await app.press("id:fold-Work");
  await app.waitFor("id:label-Work/Invoices", { state: "gone" });
  expect(app.accessibility("id:fold-Work")?.label).toBe("Unfold Work");
  expect(app.accessibility("id:mailbox-inbox")?.selected).toBe(true);
  await app.waitUntil(() => {
    try {
      return JSON.parse(files["window.json"] ?? "{}").collapsedFolders?.includes("Work") === true;
    } catch {
      return false;
    }
  });
});

test("the name opens the label's list without folding", async () => {
  const { app } = await start(JANE);
  await app.waitFor("id:label-Work");
  await app.press("id:label-Work");
  await app.waitUntil(() => app.accessibility("id:label-Work")?.selected === true);
  expect(app.shows("id:label-Work/Invoices")).toBe(true);
  expect(app.accessibility("id:mailbox-inbox")?.selected).toBe(false);
});

test("a new sub-label goes to the account whose menu asked, under its parent", async () => {
  const { app, calls } = await start(JANE);
  await app.waitFor("id:label-Work");
  await app.rightClick("id:label-Work");
  await app.press("text:New sub-label...");
  await app.waitFor("id:label-name-field");
  await app.type("id:label-name-field", "Clients");
  await app.press("text:Create");
  await app.waitUntil(() => calls.some((c) => c.method === "gmail.createLabel"));
  const create = calls.find((c) => c.method === "gmail.createLabel")!;
  expect(create.params).toEqual({ name: "Work/Clients", accountId: JANE_ID });
});

test("a name already taken is refused before the server is asked", async () => {
  const { app, calls } = await start(JANE);
  await app.waitFor("id:label-Work");
  await app.rightClick("id:label-Work");
  await app.press("text:New sub-label...");
  await app.type("id:label-name-field", "Invoices");
  await app.press("text:Create");
  await app.waitFor("text:There is already a label named Work/Invoices");
  expect(calls.some((c) => c.method === "gmail.createLabel")).toBe(false);
});

test("the switcher offers every mailbox in one list only with more than one", async () => {
  const one = await start(JANE);
  await one.app.press("id:account-footer");
  await one.app.waitFor("id:account-switcher-field");
  expect(one.app.shows("id:account-row-unified")).toBe(false);

  const two = await start(TWO);
  await two.app.press("id:account-footer");
  await two.app.waitFor("id:account-row-unified");
  await two.app.type("id:account-switcher-field", "sam");
  await two.app.waitFor("id:account-row-unified", { state: "gone" });
  expect(two.app.shows("text:Sam")).toBe(true);
  await two.app.keyboard.press("enter");
  await two.app.waitFor("id:account-switcher-field", { state: "gone" });
  await two.app.waitFor("text:sam@example.org");
});

test("Ctrl+2 opens the second row", async () => {
  const { app } = await start(JANE);
  await app.waitFor("id:label-Work");
  await app.keyboard.press("mod+2");
  await app.waitUntil(() => app.accessibility("id:mailbox-unread")?.selected === true);
});

test("the switcher's cursor walks with Down from its field and wraps", async () => {
  const { app } = await start(TWO);
  await app.press("id:account-footer");
  await app.waitFor("id:account-row-unified");
  // The cursor rests on the open account (Jane, the second row).
  await app.keyboard.press("down");
  await app.keyboard.press("down");
  await app.keyboard.press("enter");
  await app.waitFor("id:account-switcher-field", { state: "gone" });
  await app.waitUntil(() => app.accessibility("id:account-footer")?.label?.startsWith("All mailboxes") === true);
});

test("the label move picker answers j and Return", async () => {
  const { app, calls } = await start(JANE);
  await app.waitFor("id:label-Bills");
  await app.rightClick("id:label-Bills");
  await app.press("text:Move to...");
  await app.waitFor("id:label-move-row-0");
  await app.press("id:label-move-row-0");
  await app.keyboard.press("j");
  await app.keyboard.press("enter");
  await app.waitUntil(() => calls.some((c) => c.method === "gmail.renameLabel"));
  expect(calls.find((c) => c.method === "gmail.renameLabel")!.params.name.startsWith("Work/")).toBe(true);
});

test("Escape closes the switcher and goes nowhere else", async () => {
  const { app } = await start(TWO);
  await app.press("id:mailbox-sent");
  await app.press("id:account-footer");
  await app.waitFor("id:account-switcher-field");
  await app.keyboard.press("escape");
  await app.waitFor("id:account-switcher-field", { state: "gone" });
  expect(app.accessibility("id:mailbox-sent")?.selected).toBe(true);
});

test("mailbox rows carry no count, as in Qt", async () => {
  const { app } = await start(JANE);
  await app.waitFor("id:label-Work/Invoices");
  const texts = app.texts();
  // Before, the Inbox row read "Inbox", "3".
  expect(texts[texts.indexOf("Inbox") + 1]).toBe("Unread");
});

test("a JMAP account without Archive or Junk draws neither row", async () => {
  const { app } = await start([{ email: "ada@fastmail.test", provider: "jmap", label: "Ada" }]);
  await app.waitFor("id:mailbox-inbox");
  await app.waitFor("id:mailbox-archive", { state: "gone" });
  expect(app.shows("id:mailbox-spam")).toBe(false);
  expect(app.shows("id:mailbox-trash")).toBe(true);
});

test("the accounts' Microsoft 365 check without an Archive folder drops that row, asked once", async () => {
  const { app, calls } = await start([{ email: "bo@corp.test", provider: "m365", label: "Bo" }]);
  await app.waitUntil(() => calls.some((c) => c.method === "m365.verify"));
  expect(calls.find((c) => c.method === "m365.verify")!.params).toEqual({ accountId: "m365:bo@corp.test" });
  // The sidebar asks nothing itself: the fixture's one startup check is the only one.
  await app.wait(200);
  expect(calls.filter((c) => c.method === "m365.verify").length).toBe(1);
  await app.waitFor("id:mailbox-archive", { state: "gone" });
  expect(app.shows("id:mailbox-trash")).toBe(true);
});

const JANE_ID = "jane@example.com";
