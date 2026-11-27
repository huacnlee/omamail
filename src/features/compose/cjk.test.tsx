// Typing Chinese in compose: an input method's marked text never commits a
// chip, sends, saves, leaves or runs a key; what it commits lands whole; CJK
// names find contacts; long CJK text fits at base 14 and 16. Synthetic
// mailbox and contacts only. On macOS (`--target macos`) it also shoots a
// field mid-composition.
import { expect, open, test } from "nsh/test";
import { assertGuarded, openGuarded } from "../../testing/previewGuard";

type App = Awaited<ReturnType<typeof open>>;

async function start(entry = "./fixtures/Cjk.tsx") {
  const { app, guard } = await openGuarded(entry, { width: 1000, height: 760 });
  await app.press("id:new");
  await app.waitFor("id:compose");
  return { app, guard };
}

function probe(app: App, name: string): string {
  const prefix = `${name}=`;
  return (app.texts() as string[]).find((t) => t.startsWith(prefix))?.slice(prefix.length) ?? "";
}

async function until(app: App, check: () => boolean, what: string, timeout = 2000) {
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

test("To: marked pinyin is not a chip; a committed CJK name finds its contact", async () => {
  const { app, guard } = await start();
  await app.compose("id:compose-to", "wang");
  expect(probe(app, "to")).toBe("");
  expect(app.shows("id:compose-to-suggestion-0")).toBe(false);
  await app.compose("id:compose-to", "");
  await app.type("id:compose-to", "王");
  await app.waitFor("id:compose-to-suggestion-0");
  expect(app.shows("王小明")).toBe(true);
  await app.press("id:compose-to-suggestion-0");
  await until(app, () => probe(app, "to") === "王小明 <wang@example.cn>, ", "the chosen contact is a chip in To");
  expect(app.shows("王小明")).toBe(true);
  assertGuarded(guard);
});

// Enter inside a composition belongs to the input method, which decides what
// it commits: headless keeps composing, macOS commits the letters typed (as
// Pinyin does on Return). So these tests check what holds on both: nothing
// marked reaches the draft, and no app key runs. ChipInput's own Return
// hand-off is ui's (src/ui/ime.test.tsx).
test("To: separators inside a composition commit nothing", async () => {
  const { app, guard } = await start();
  await app.compose("id:compose-to", "a,b;c d");
  await app.wait(100);
  expect(probe(app, "to")).toBe("");
  await app.compose("id:compose-to", "");
  expect(probe(app, "to")).toBe("");
  // After the composition, Enter commits what was typed.
  await app.type("id:compose-to", "wang@example.cn");
  await app.keyboard.press("enter");
  await until(app, () => probe(app, "to") === "wang@example.cn, ", "Enter commits the address");
  assertGuarded(guard);
});

// What Escape does to the marked text is the input method's (and, on macOS,
// NSH's: see <scratchpad>/nsh-issue-macos-marked-text-value.md); the app's part
// is that Escape while composing neither leaves compose nor asks to save.
test("To: Escape while composing stays in compose", async () => {
  const { app, guard } = await start();
  await app.compose("id:compose-to", "wang");
  await app.keyboard.press("escape");
  await app.wait(100);
  expect(probe(app, "opened")).toBe("true");
  expect(app.shows("Save this draft?")).toBe(false);
  await app.compose("id:compose-to", "");
  assertGuarded(guard);
});

test("To: full-width ， and ； are text, not separators (as in the Qt app)", async () => {
  const { app, guard } = await start();
  await app.type("id:compose-to", "李雷，ann@example.net；");
  // Nothing split off (a split writes ", "): Qt's Recipients.js splits on ASCII , and ; only.
  expect(probe(app, "to")).toBe("李雷，ann@example.net；");
  await app.keyboard.press("enter");
  await until(app, () => probe(app, "to") === "李雷，ann@example.net；, ", "one entry, as typed");
  assertGuarded(guard);
});

test("Subject: marked text leaves the value; committed CJK and emoji land whole", async () => {
  const { app, guard } = await start();
  await app.compose("id:compose-subject", "jidu");
  await app.wait(100);
  expect(probe(app, "subject")).toBe("");
  await app.compose("id:compose-subject", "");
  expect(probe(app, "subject")).toBe("");
  await app.type("id:compose-subject", "Hello 世界 😀 季度回顾");
  await until(app, () => probe(app, "subject") === "Hello 世界 😀 季度回顾", "the subject as typed");
  assertGuarded(guard);
});

test("Body: Cmd/Ctrl+Enter, Escape and pinyin letters while composing neither send, leave nor run keys", async () => {
  const { app, guard } = await start();
  await app.type("id:compose-to", "wang@example.cn");
  await app.keyboard.press("enter");
  await app.type("id:compose-body", "你好，世界");
  await app.compose("id:compose-body", "zhong");
  await app.keyboard.press("mod+enter");
  await app.wait(200);
  expect(probe(app, "outbox")).toBe("0");
  expect(probe(app, "body")).toBe(JSON.stringify("你好，世界"));
  // Single letters of pinyin never run the app's one-letter keys.
  await app.compose("id:compose-body", "ecdjk");
  expect(probe(app, "stray")).toBe("0");
  await app.keyboard.press("escape");
  expect(probe(app, "opened")).toBe("true");
  await app.compose("id:compose-body", "");
  // Composition over: Cmd/Ctrl+Enter sends.
  await app.keyboard.press("mod+enter");
  await until(app, () => probe(app, "outbox") === "1", "the draft reaches the synthetic outbox");
  assertGuarded(guard);
});

// Skipped: NSH's multiline Input (under ui's TextEditor) takes Enter as a line
// break while an input method composes; its single-line Input does not. NSH
// owns it; the issue draft is <scratchpad>/nsh-issue-multiline-enter-composing.md.
// Un-skip as written once NSH leaves that Enter to the input method.
test.skip("Body: Enter while composing does not break the line", async () => {
  const { app, guard } = await start();
  await app.type("id:compose-body", "你好，世界");
  await app.compose("id:compose-body", "zhong");
  await app.keyboard.press("enter");
  await app.wait(100);
  expect(probe(app, "body")).toBe(JSON.stringify("你好，世界"));
  await app.compose("id:compose-body", "");
  // Composition over: Enter breaks the line.
  await app.keyboard.press("enter");
  await until(app, () => probe(app, "body") === JSON.stringify("你好，世界\n"), "Enter breaks the line");
  assertGuarded(guard);
});

test("Recovery saves what was committed, never the marked text", async () => {
  const { app, guard } = await start();
  await app.type("id:compose-body", "Hello 世界 😀");
  await until(app, () => probe(app, "recovery").includes("Hello 世界 😀"), "the committed text is saved");
  // Composing past the save delay (400 ms) saves nothing marked.
  await app.compose("id:compose-body", "zhongwen");
  await app.wait(700);
  expect(probe(app, "recovery").includes("zhongwen")).toBe(false);
  expect(probe(app, "recovery").includes("Hello 世界 😀")).toBe(true);
  // Cancelled, it never reaches the draft; the next save has the subject.
  await app.compose("id:compose-body", "");
  await app.type("id:compose-subject", "主题");
  await until(app, () => probe(app, "recovery").includes("主题"), "a later save");
  expect(probe(app, "recovery").includes("zhongwen")).toBe(false);
  assertGuarded(guard);
});

test("Contacts search filters by committed CJK, not marked pinyin", async () => {
  const { app, guard } = await start();
  await app.press("id:compose-contacts");
  await app.waitFor("id:compose-contacts-search");
  await app.waitFor("id:contact-2");
  await app.compose("id:compose-contacts-search", "li");
  // Marked text filters nothing: every contact still listed.
  expect(app.shows("id:contact-2")).toBe(true);
  await app.compose("id:compose-contacts-search", "");
  await app.type("id:compose-contacts-search", "李");
  await app.waitFor("id:contact-1", { state: "gone" });
  expect(app.shows("李雷")).toBe(true);
  expect(app.shows("王小明")).toBe(false);
  assertGuarded(guard);
});

for (const [base, entry] of [["14", "./fixtures/Cjk.tsx"], ["16", "./fixtures/Cjk16.tsx"]] as const) {
  test(`long CJK text stays inside its field at base ${base}`, async () => {
    const { app, guard } = await start(entry);
    const long = "关于第四季度预算与人员安排的会议纪要以及后续需要跟进的事项清单".repeat(3);
    await app.type("id:compose-subject", long);
    await app.type("id:compose-body", long);
    const compose = app.layout("id:compose")!;
    for (const id of ["compose-subject", "compose-body"]) {
      const box = app.layout(`id:${id}`)!;
      expect(box.clipped).toBe(false);
      expect(box.x + box.width).toBeLessThanOrEqual(compose.x + compose.width + 0.5);
    }
    // A CJK line is not cut vertically: the subject keeps its control height.
    expect(app.layout("id:compose-subject")!.height).toBeGreaterThanOrEqual(base === "14" ? 30 : 34);
    await app.compose("id:compose-body", "zhongwen shuru");
    await shot(app, `.nsh/shots/compose-cjk-composing-${base}.png`);
    await app.compose("id:compose-body", "");
    assertGuarded(guard);
  });
}
