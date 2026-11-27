// Typing Chinese in account setup and Settings: an input method's marked text
// never changes a field's value, submits a sign-in, leaves the page or runs a
// one-letter key; what it commits lands whole and reaches the saved registry;
// long CJK text fits at base 14 and 16. Synthetic accounts only; the leak
// guard proves nothing reached this machine. On macOS (`--target macos`) it
// also shoots a field mid-composition.
import { expect, open, test } from "nsh/test";
import * as Accounts from "../../mail/accounts";
import * as Aliases from "../../mail/aliases";
import { assertGuarded, openGuarded } from "../../testing/previewGuard";

type App = Awaited<ReturnType<typeof open>>;

function probe(app: App, name: string): string {
  const prefix = `${name}=`;
  return (app.texts() as string[]).find((t) => t.startsWith(prefix))?.slice(prefix.length) ?? "";
}

async function until(app: App, check: () => boolean, what: string, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error(`${what}; on screen: ${(app.texts() as string[]).join(" | ")}`);
    await app.wait(25);
  }
}

async function shot(app: App, path: string) {
  try {
    await app.screenshot(path);
  } catch (error) {
    if (!String((error as Error).message).includes("real platform")) throw error;
  }
}

/** Whether this run drives a real platform (`--target`): only it draws a screenshot. */
async function onTarget(app: App): Promise<boolean> {
  try {
    await app.screenshot();
    return true;
  } catch {
    return false;
  }
}

async function start(entry = "./fixtures/Cjk.tsx") {
  const { app, guard } = await openGuarded(entry, { width: 1180, height: 800 });
  await app.waitFor("id:preview-picker");
  return { app, guard };
}

async function setup(app: App, provider: "imap" | "m365") {
  await app.press("id:preview-picker");
  await app.press("id:provider-" + provider);
  await app.waitFor("id:setup-address");
}

/** Marked pinyin leaves the value; the committed CJK lands whole. Headless
 * reads the value without the marked text; macOS reads the native field's
 * text, marked text included, until the composition ends. */
async function commits(app: App, id: string, pinyin: string, text: string) {
  const before = app.value("id:" + id) ?? "";
  await app.compose("id:" + id, pinyin);
  expect([before, before + pinyin]).toContain(app.value("id:" + id));
  await app.compose("id:" + id, "");
  expect(app.value("id:" + id)).toBe(before);
  await app.type("id:" + id, text);
  expect(app.value("id:" + id)).toBe(before + text);
}

test("IMAP setup: names, the host and aliases take committed CJK, never the marked text", async () => {
  const { app, guard } = await start();
  await setup(app, "imap");
  await commits(app, "setup-name", "gongzuo", "工作");
  await commits(app, "setup-sender-name", "zhangsan", "张三");
  await commits(app, "setup-address", "zhang", "zhang@example.cn");
  await app.press("id:imap-server-disclosure");
  await app.waitFor("id:setup-imap-host");
  await commits(app, "setup-imap-host", "youjian", "邮件.example.cn");
  // Aliases are parsed on save, not as typed: a composition splits nothing.
  await commits(app, "setup-aliases", "a,b;c", "李雷 <li@example.cn>, Hello 世界 😀 <hi@example.cn>");
  expect(probe(app, "page")).toBe("setup");
  assertGuarded(guard);
});

test("M365 setup: pinyin letters run no keys; Enter after the composition signs in", async () => {
  const { app, guard } = await start();
  await setup(app, "m365");
  await app.type("id:setup-address", "ops@example.cn");
  await app.type("id:setup-client-id", "00000000-0000-4000-8000-000000000002");
  // One-letter keys spelled in pinyin run nothing.
  await app.compose("id:setup-client-id", "ecdjk/[?");
  expect(probe(app, "page")).toBe("setup");
  expect(probe(app, "signins")).toBe("0");
  await app.compose("id:setup-client-id", "");
  expect(app.value("id:setup-client-id")).toBe("00000000-0000-4000-8000-000000000002");
  // Composition over: Enter signs in.
  await app.keyboard.press("enter");
  await until(app, () => probe(app, "signins") === "1", "Enter after the composition begins the sign-in");
  await app.waitFor("WDJB-MJHT");
  await app.press("Cancel");
  assertGuarded(guard);
});

test("M365 setup: Enter while composing picks a candidate, never signs in", async () => {
  const { app, guard } = await start();
  await setup(app, "m365");
  await app.type("id:setup-address", "ops@example.cn");
  await app.type("id:setup-client-id", "00000000-0000-4000-8000-000000000002");
  await app.compose("id:setup-client-id", "zhongwen");
  await app.keyboard.press("enter");
  await app.wait(200);
  expect(probe(app, "signins")).toBe("0");
  expect(app.shows("WDJB-MJHT")).toBe(false);
  expect(probe(app, "page")).toBe("setup");
  // The input method's own Return: headless ends the composition, macOS Pinyin
  // commits the letters as typed. Never a sign-in either way.
  expect(["", "zhongwen"].map((t) => "00000000-0000-4000-8000-000000000002" + t)).toContain(app.value("id:setup-client-id"));
  assertGuarded(guard);
});

// Escape is the input method's while it composes: the router binds nothing then
// (src/keys/router.ts). On macOS NSH's text input still unfocuses the field on
// cancelOperation: during marked text (scratchpad NSH issue 4), so the
// field-keeps-the-focus half runs headless only until that is fixed.
test("M365 setup: Escape while composing cancels the composition only", async () => {
  const { app, guard } = await start();
  await setup(app, "m365");
  await app.type("id:setup-client-id", "00000000-0000-4000-8000-000000000002");
  await app.waitUntil(() => app.value("id:setup-client-id") === "00000000-0000-4000-8000-000000000002");
  await app.compose("id:setup-client-id", "zhongwen");
  await app.keyboard.press("escape");
  await app.wait(200);
  expect(probe(app, "page")).toBe("setup");
  expect(probe(app, "signins")).toBe("0");
  // What was typed before the composition survives on both drivers.
  expect((app.value("id:setup-client-id") ?? "").startsWith("00000000-0000-4000-8000-000000000002")).toBe(true);
  if (!(await onTarget(app))) {
    await app.compose("id:setup-client-id", "");
    expect(app.value("id:setup-client-id")).toBe("00000000-0000-4000-8000-000000000002");
  }
  assertGuarded(guard);
});

test("one-letter keys never fire while a setup field has the focus", async () => {
  const { app, guard } = await start();
  await setup(app, "imap");
  // Typed into the field, the keys are text: the page stays and the field holds them.
  await app.type("id:setup-name", "工");
  for (const key of ["c", "e", "d", "j", "k", "/", "[", "shift+/"]) {
    await app.keyboard.press(key);
    expect(probe(app, "page")).toBe("setup");
  }
  expect(app.value("id:setup-name")).toBe("工cedjk/[?");
  assertGuarded(guard);
});

async function openSettings(app: App) {
  await app.press("id:preview-settings");
  await app.waitFor("id:settings-mailbox-name");
}

test("Settings: mailbox name, your name and signature round-trip CJK through the saved registry", async () => {
  const { app, guard } = await start();
  await openSettings(app);
  // Marked text never reaches the store, on either driver.
  await app.compose("id:settings-mailbox-name", "gongzuo");
  await app.wait(700);
  expect(probe(app, "label")).toBe("");
  await app.compose("id:settings-mailbox-name", "");
  await commits(app, "settings-mailbox-name", "gongzuo", "工作");
  await app.clear("id:settings-sender-name");
  await app.waitUntil(() => app.value("id:settings-sender-name") === "");
  await commits(app, "settings-sender-name", "zhangsan", "张三");
  await until(app, () => probe(app, "label") === "工作" && probe(app, "sender") === "张三", "the names reach accounts.save");
  // The signature: committed CJK, emoji and a line break are saved; marked text is not.
  await app.type("id:settings-signature-editor", "Hello 世界 😀\n此致敬礼");
  await until(app, () => probe(app, "signature") === JSON.stringify("Hello 世界 😀\n此致敬礼"), "the signature reaches accounts.save");
  await app.compose("id:settings-signature-editor", "zhangsan");
  await app.wait(700);
  expect(probe(app, "signature")).toBe(JSON.stringify("Hello 世界 😀\n此致敬礼"));
  await app.compose("id:settings-signature-editor", "");
  // Reloaded: leaving Settings and coming back reads the same values into the fields.
  await app.press("id:settings-back");
  await openSettings(app);
  expect(app.value("id:settings-mailbox-name")).toBe("工作");
  expect(app.value("id:settings-sender-name")).toBe("张三");
  expect(app.value("id:settings-signature-editor")).toBe("Hello 世界 😀\n此致敬礼");
  assertGuarded(guard);
});

test("Settings: Enter while composing in the signature keeps the page and the saved text", async () => {
  const { app, guard } = await start();
  await openSettings(app);
  await app.type("id:settings-signature-editor", "此致敬礼");
  await until(app, () => probe(app, "signature") === JSON.stringify("此致敬礼"), "the signature reaches accounts.save");
  await app.compose("id:settings-signature-editor", "zhangsan");
  await app.keyboard.press("enter");
  expect(probe(app, "page")).toBe("settings");
  await app.wait(700);
  // Headless ends the composition; macOS Pinyin's Return commits the letters. No line break either way.
  expect([JSON.stringify("此致敬礼"), JSON.stringify("此致敬礼zhangsan")]).toContain(probe(app, "signature"));
  assertGuarded(guard);
});

// See the M365 Escape case: the page stays on both drivers; the field keeping
// the focus is asserted headless only until NSH issue 4 is fixed.
test("Settings: Escape while composing keeps the page", async () => {
  const { app, guard } = await start();
  await openSettings(app);
  await app.compose("id:settings-signature-editor", "zhangsan");
  await app.keyboard.press("escape");
  await app.wait(200);
  expect(probe(app, "page")).toBe("settings");
  if (!(await onTarget(app))) await app.compose("id:settings-signature-editor", "");
  assertGuarded(guard);
});

test("the registry keeps CJK names and signatures through serialize and load", () => {
  let list = Accounts.load(JSON.stringify({
    version: 1,
    accounts: [
      {
        id: "imap:zhang@example.cn",
        provider: "imap",
        email: "zhang@example.cn",
        imap: { host: "imap.example.cn", port: 993, smtpHost: "smtp.example.cn", smtpPort: 465, username: "zhang@example.cn" },
      },
    ],
  }));
  list = Accounts.setLabel(list, "imap:zhang@example.cn", "工作");
  list = Accounts.setSenderName(list, "imap:zhang@example.cn", "张三");
  list = Accounts.setSignature(list, "imap:zhang@example.cn", "Hello 世界 😀\n此致敬礼");
  const again = Accounts.load(Accounts.serialize(list));
  const row = Accounts.find(again, "imap:zhang@example.cn")!;
  expect(row).not.toBeNull();
  expect(row.label).toBe("工作");
  expect(row.senderName).toBe("张三");
  expect(row.signature).toBe("Hello 世界 😀\n此致敬礼");
});

test("aliases: CJK names parse; full-width ， is text, as in the Qt app (Aliases.js splits on ASCII , only)", () => {
  const parsed = Aliases.parse('李雷 <li@example.cn>, "王, 小明" <wang@example.cn> (default)');
  expect(JSON.parse(JSON.stringify(parsed))).toEqual([
    { email: "li@example.cn", displayName: "李雷", isPrimary: false, isDefault: false },
    { email: "wang@example.cn", displayName: "王, 小明", isPrimary: false, isDefault: true },
  ]);
  expect(Aliases.parse("a@example.cn，b@example.cn").length).not.toBe(2);
});

for (const [base, entry] of [["14", "./fixtures/Cjk.tsx"], ["16", "./fixtures/Cjk16.tsx"]] as const) {
  test(`long CJK text stays inside its fields at base ${base}`, async () => {
    const { app, guard } = await start(entry);
    const long = "关于第四季度预算与人员安排的会议纪要以及后续需要跟进的事项清单".repeat(3);
    await setup(app, "imap");
    await app.type("id:setup-name", long);
    const field = app.layout("id:setup-name")!;
    const page = app.layout("id:setup-address")!;
    expect(field.clipped).toBe(false);
    expect(field.x + field.width).toBeLessThanOrEqual(page.x + page.width + 0.5);
    expect(field.height).toBeGreaterThanOrEqual(base === "14" ? 30 : 34);
    // The placeholder hides while composing; the marked text stays in the field.
    await app.compose("id:setup-sender-name", "zhang san feng");
    expect(app.layout("id:setup-sender-name")!.clipped).toBe(false);
    await shot(app, `.nsh/shots/accounts-cjk-composing-${base}.png`);
    await app.compose("id:setup-sender-name", "");
    await app.press("Back");
    await app.press("Back");
    await app.press("id:preview-settings");
    await app.waitFor("id:settings-mailbox-name");
    await app.press("id:settings-rail-mailboxes");
    await app.waitUntil(() => app.layout("id:settings-mailbox-name")?.clipped === false);
    await app.type("id:settings-mailbox-name", long);
    const name = app.layout("id:settings-mailbox-name")!;
    const column = app.layout("id:settings-section-mailboxes")!;
    expect(name.clipped).toBe(false);
    expect(name.x + name.width).toBeLessThanOrEqual(column.x + column.width + 0.5);
    expect(name.height).toBeGreaterThanOrEqual(base === "14" ? 30 : 34);
    await app.press("id:settings-rail-writing");
    await app.waitUntil(() => app.layout("id:settings-signature-editor")?.clipped === false);
    await app.type("id:settings-signature-editor", long);
    const editor = app.layout("id:settings-signature-editor")!;
    expect(editor.clipped).toBe(false);
    expect(editor.x + editor.width).toBeLessThanOrEqual(column.x + column.width + 0.5);
    await app.compose("id:settings-signature-editor", "cizhi jingli");
    await shot(app, `.nsh/shots/settings-cjk-composing-${base}.png`);
    await app.compose("id:settings-signature-editor", "");
    assertGuarded(guard);
  });
}
