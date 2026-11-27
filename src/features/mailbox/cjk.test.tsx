// Chinese input in the mailbox feature's fields: the label name prompt, the
// Move to / Label as filters and the account switcher's filter. An input
// method composes pinyin marked at the caret; nothing may act on it until a
// character is chosen: Return picks the candidate (no create, no choice),
// Escape cancels the composition (the dialog stays). Headless and on
// macOS (cjk-macos.test.tsx) alike, neither reaches the field's submit or the
// escape layers while composing. Names the server stores
// come back as plain text and elide in the sidebar's name lane. Synthetic
// accounts and labels on a stand-in backend only.
import { expect, open, test } from "nsh/test";

type Acct = { email: string; provider: string; label?: string };
type Label = { id: string; name: string; rawName: string; system?: boolean; unread: number };

const LONG = "客户合同与发票归档二零二六年度第一季度";

function backend(accounts: Acct[], calls: { method: string; params: any }[], labels: Label[]) {
  const files: Record<string, string> = {};
  let next = 100;
  return {
    "omamail-native": {
      "Backend.request": (method: string, params: any) => {
        calls.push({ method, params });
        if (method === "accounts.read") return { result: { revision: "r1", registry: { version: 1, accounts, activeId: "" } } };
        if (method === "gmail.labels") return { result: labels.map((l) => ({ ...l })) };
        // IMAP names travel in modified UTF-7; core decodes them (read/tests.rs) and keeps the encoded id.
        if (method === "imap.folders")
          return { result: { labels: [
            { id: "INBOX", name: "INBOX", rawName: "INBOX", system: true, unread: 0 },
            { id: "&Ti1lhw-", name: "中文", rawName: "&Ti1lhw-", delimiter: "/", unread: 2 },
          ] } };
        // The server keeps the name as given, as Gmail does.
        if (method === "gmail.createLabel") {
          const label = { id: `Label_${next++}`, name: params.name, rawName: params.name, unread: 0 };
          labels.push(label);
          return { result: label };
        }
        if (method === "gmail.renameLabel") {
          const label = labels.find((l) => l.id === params.labelId || l.id === params.id);
          if (label) label.name = label.rawName = params.name;
          return { result: label ?? null };
        }
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

const LI: Acct[] = [{ email: "li@example.test", provider: "gmail", label: "李雷" }];
const TWO: Acct[] = [...LI, { email: "han@example.test", provider: "gmail", label: "韩梅梅" }];

function labels(): Label[] {
  return [
    { id: "INBOX", name: "Inbox", rawName: "INBOX", system: true, unread: 0 },
    { id: "Label_1", name: "工作", rawName: "工作", unread: 0 },
    { id: "Label_2", name: "工作/发票", rawName: "工作/发票", unread: 4 },
    { id: "Label_3", name: "Travel", rawName: "Travel", unread: 0 },
    { id: "Label_4", name: LONG, rawName: LONG, unread: 12 },
  ];
}

async function start(accounts: Acct[] = LI, width = 1280) {
  const calls: { method: string; params: any }[] = [];
  const app = await open("./fixtures/SidebarApp.tsx", { modules: backend(accounts, calls, labels()), width, height: 820, platform: "linux" });
  await app.waitFor("id:label-工作");
  return { app, calls };
}

test("a label named in Chinese is created only once the composition commits", async () => {
  const { app, calls } = await start();
  await app.rightClick("id:label-工作");
  await app.press("text:New sub-label...");
  await app.waitFor("id:label-name-field");

  await app.compose("id:label-name-field", "ke'hu");
  // Marked text is not the value: Create stays off, and Return picks the candidate.
  expect(app.value("id:label-name-field")).toBe("");
  expect(app.enabled("text:Create")).toBe(false);
  await app.keyboard.press("enter");
  // Escape cancels the composition only: the prompt stays open.
  await app.keyboard.press("escape");
  await app.wait(100);
  expect(app.shows("id:label-name-field")).toBe(true);
  expect(calls.some((c) => c.method === "gmail.createLabel")).toBe(false);

  await app.compose("id:label-name-field", "");
  await app.type("id:label-name-field", "客户");
  expect(app.value("id:label-name-field")).toBe("客户");
  await app.keyboard.press("enter");
  await app.waitUntil(() => calls.some((c) => c.method === "gmail.createLabel"));
  expect(calls.find((c) => c.method === "gmail.createLabel")!.params).toEqual({ name: "工作/客户", accountId: "li@example.test" });
  // The server's list comes back with it: a row under 工作, named in plain text.
  await app.waitFor("id:label-工作/客户");
  expect(app.shows("text:客户")).toBe(true);
});

test("an IMAP folder shows its decoded Chinese name; a rename sends the encoded id and the plain new name", async () => {
  const calls: { method: string; params: any }[] = [];
  const app = await open("./fixtures/SidebarApp.tsx", {
    modules: backend([{ email: "wang@example.test", provider: "imap", label: "王" }], calls, []),
    width: 1280, height: 820, platform: "linux",
  });
  await app.waitFor("id:label-中文");
  await app.rightClick("id:label-中文");
  await app.waitFor("text:Rename...");
  await app.wait(150);
  await app.press("text:Rename...");
  await app.waitFor("id:label-name-field");
  await app.clear("id:label-name-field");
  await app.type("id:label-name-field", "中文邮件");
  await app.keyboard.press("enter");
  await app.waitUntil(() => calls.some((c) => c.method === "imap.renameFolder"));
  // Core encodes the new name (mutation/tests.rs: modified UTF-7); the UI sends it as typed.
  expect(calls.find((c) => c.method === "imap.renameFolder")!.params).toEqual({ id: "&Ti1lhw-", name: "中文邮件", accountId: "imap:wang@example.test" });
});

test("Return and Escape during a composition stay with the input method in the pickers and the rename prompt", async () => {
  const { app, calls } = await start(TWO);

  // Move to: Return picks the candidate (no choice), Escape cancels the composition (the dialog stays).
  await app.press("id:open-move-picker");
  await app.waitFor("id:move-picker-field");
  await app.compose("id:move-picker-field", "fa'piao");
  await app.keyboard.press("enter");
  await app.keyboard.press("escape");
  await app.wait(150);
  expect(app.shows("id:move-picker-field")).toBe(true);
  expect(app.texts().some((t) => t.startsWith("Label_"))).toBe(false);
  // Committed, Escape closes it as usual.
  await app.compose("id:move-picker-field", "");
  await app.keyboard.press("escape");
  await app.waitFor("id:move-picker-field", { state: "gone" });

  // Label as: the same.
  await app.press("id:open-label-picker");
  await app.waitFor("id:label-picker-field");
  await app.compose("id:label-picker-field", "gong'zuo");
  await app.keyboard.press("enter");
  await app.keyboard.press("escape");
  await app.wait(150);
  expect(app.shows("id:label-picker-field")).toBe(true);
  expect(app.texts().some((t) => t.startsWith("Label_"))).toBe(false);
  await app.compose("id:label-picker-field", "");
  await app.keyboard.press("escape");
  await app.waitFor("id:label-picker-field", { state: "gone" });

  // Account switcher: Escape mid-composition keeps the popover.
  await app.press("id:account-footer");
  await app.waitFor("id:account-switcher-field");
  await app.compose("id:account-switcher-field", "han");
  await app.keyboard.press("enter");
  await app.wait(150);
  expect(app.shows("id:account-switcher-field")).toBe(true);
  await app.keyboard.press("escape");
  await app.wait(150);
  expect(app.shows("id:account-switcher-field")).toBe(true);
  await app.compose("id:account-switcher-field", "");
  await app.keyboard.press("escape");
  await app.waitFor("id:account-switcher-field", { state: "gone" });

  // Rename: Return mid-composition renames nothing; Escape keeps the prompt.
  await app.rightClick("id:label-Travel");
  await app.waitFor("text:Rename...");
  await app.wait(150);
  await app.press("text:Rename...");
  await app.waitFor("id:label-name-field");
  await app.compose("id:label-name-field", "lv'xing");
  await app.keyboard.press("enter");
  await app.keyboard.press("escape");
  await app.wait(150);
  expect(app.shows("id:label-name-field")).toBe(true);
  expect(calls.some((c) => c.method === "gmail.renameLabel")).toBe(false);
  await app.compose("id:label-name-field", "");
  await app.keyboard.press("escape");
  await app.waitFor("id:label-name-field", { state: "gone" });
  expect(calls.some((c) => c.method === "gmail.renameLabel")).toBe(false);
});

test("a rename to mixed Chinese, Latin and emoji round-trips", async () => {
  const { app, calls } = await start();
  await app.rightClick("id:label-Travel");
  await app.waitFor("text:Rename...");
  // The menu takes presses once it has opened.
  await app.wait(150);
  await app.press("text:Rename...");
  await app.waitFor("text:Rename Travel");
  expect(app.value("id:label-name-field")).toBe("Travel");
  await app.compose("id:label-name-field", "shi'jie");
  expect(app.value("id:label-name-field")).toBe("Travel");
  await app.compose("id:label-name-field", "");
  expect(app.value("id:label-name-field")).toBe("Travel");
  await app.clear("id:label-name-field");
  await app.type("id:label-name-field", "Hello 世界 😀");
  await app.press("text:Rename");
  await app.waitUntil(() => calls.some((c) => c.method === "gmail.renameLabel"));
  expect(calls.find((c) => c.method === "gmail.renameLabel")!.params.name).toBe("Hello 世界 😀");
  await app.waitFor("id:label-Hello 世界 😀");
});

test("the Move to filter matches Chinese names once committed", async () => {
  const { app } = await start();
  await app.press("id:open-move-picker");
  await app.waitFor("id:move-picker-field");
  const all = app.count("id:move-picker-row-0") > 0;
  expect(all).toBe(true);

  await app.compose("id:move-picker-field", "fa'piao");
  // Marked pinyin filters nothing.
  expect(app.shows("id:move-picker-row-2")).toBe(true);

  await app.compose("id:move-picker-field", "");
  await app.type("id:move-picker-field", "发票");
  // 工作/发票, and the long label that has 发票 in its name.
  await app.waitFor("id:move-picker-row-2", { state: "gone" });
  expect(app.count("id:move-picker-row-1")).toBe(1);
  await app.keyboard.press("enter");
  await app.waitFor("id:move-picker-field", { state: "gone" });
  await app.waitUntil(() => app.texts().includes("Label_2 m1"));
});

test("the Label as filter matches a Chinese parent name", async () => {
  const { app } = await start();
  await app.press("id:open-label-picker");
  await app.waitFor("id:label-picker-field");
  await app.type("id:label-picker-field", "工作");
  await app.waitFor("id:label-picker-row-2", { state: "gone" });
  // 工作 and 工作/发票; Travel and the long label are filtered out.
  expect(app.count("id:label-picker-row-0")).toBe(1);
  expect(app.count("id:label-picker-row-1")).toBe(1);
});

test("the account switcher finds a Chinese name once committed", async () => {
  const { app } = await start(TWO);
  await app.press("id:account-footer");
  await app.waitFor("id:account-switcher-field");
  await app.compose("id:account-switcher-field", "han");
  expect(app.shows("id:account-row-unified")).toBe(true);
  await app.compose("id:account-switcher-field", "");
  await app.type("id:account-switcher-field", "韩");
  await app.waitFor("id:account-row-unified", { state: "gone" });
  expect(app.shows("text:韩梅梅")).toBe(true);
  expect(app.shows("id:account-row-1")).toBe(false);
  await app.keyboard.press("enter");
  await app.waitFor("id:account-switcher-field", { state: "gone" });
  await app.waitFor("text:han@example.test");
});

test("a bracket typed into a picker field is text, not the sidebar toggle", async () => {
  const { app } = await start();
  await app.press("id:open-move-picker");
  await app.waitFor("id:move-picker-field");
  await app.type("id:move-picker-field", "[");
  expect(app.value("id:move-picker-field")).toBe("[");
  expect(app.shows("text:Travel") || app.shows("id:label-Travel")).toBe(true);
  expect(app.layout("id:label-Travel")?.width ?? 0).toBeGreaterThan(100);
});

for (const width of [1280, 900]) {
  test(`a long Chinese label elides in the name lane, its count still in the lane (${width})`, async () => {
    const { app } = await start(LI, width);
    const row = app.layout(`id:label-${LONG}`)!;
    const count = app.layout(`id:label-${LONG}-count`)!;
    const travelCount = app.layout("id:label-工作/发票-count")!;
    expect(row.clipped).toBe(false);
    // The count lane ends where every row's does, inside the row.
    expect(count.x + count.width).toBe(travelCount.x + travelCount.width);
    expect(count.x + count.width).toBeLessThanOrEqual(row.x + row.width);
    expect(count.height).toBeLessThanOrEqual(row.height);
    // The name keeps every point the lanes leave: it starts where Travel's does and ends at the count lane.
    expect(app.shows("text:12")).toBe(true);
    expect(row.height).toBe(app.layout("id:label-Travel")!.height);
  });
}
