// Chinese input in the dock. While an input method composes, its keys are
// its own: Enter picks a candidate and Escape cancels the composition, so
// neither may send, close the panel or interrupt, and "/" commands open
// only from committed text. The app's own guard does it: ui's fields report
// the composition (`imeComposing()`) and the key router binds nothing while
// it lasts, so the checks hold headless and on Linux, not only where the
// platform holds bindings back itself (macOS).
import { expect, open, test } from "nsh/test";
import { assertGuarded, openGuarded } from "../../testing/previewGuard";

const APP = "./fixtures/CjkApp.tsx";
const FIELD = "label:Message AI";

type App = Awaited<ReturnType<typeof open>>;
const text = (app: App, id: string) => app.texts().find((t) => t.startsWith(id + ":")) ?? "";
const commandsShown = (app: App) => app.texts().some((t) => t.includes("New chat") || t.includes("History..."));

/** Takes a screenshot on a real platform; false headless. */
async function shot(app: App, path: string): Promise<boolean> {
  try {
    await app.screenshot(path);
    return true;
  } catch (error) {
    if (!String((error as Error).message).includes("real platform")) throw error;
    return false;
  }
}

test("marked pinyin is not the value; committed Chinese is, and Enter then sends it", async () => {
  const { app, guard } = await openGuarded(APP, { width: 1100, height: 760 });
  await app.waitFor("Send email");

  await app.compose(FIELD, "zhong");
  expect(text(app, "value")).toBe("value:");
  expect(text(app, "asked")).toBe("asked:");
  await shot(app, ".nsh/shots/assistant-cjk-composing.png");
  await app.compose(FIELD, "");

  // A "/" being composed opens no commands; a committed one does.
  await app.compose(FIELD, "/");
  expect(commandsShown(app)).toBe(false);
  await app.compose(FIELD, "");
  await app.type(FIELD, "/");
  await app.waitUntil(() => commandsShown(app));
  await app.keyboard.press("backspace");
  await app.waitUntil(() => !commandsShown(app));

  await app.type(FIELD, "总结这封邮件 Hello 世界 😀");
  expect(text(app, "value")).toBe("value:总结这封邮件 Hello 世界 😀");
  await app.keyboard.press("enter");
  await app.waitUntil(() => text(app, "asked") !== "asked:");
  assertGuarded(guard);
});

test("Enter and Escape during a composition stay the input method's", async () => {
  const { app, guard } = await openGuarded(APP, { width: 1100, height: 760 });
  await app.waitFor("Send email");
  // Committed text, then more being composed: Enter picks the candidate.
  await app.type(FIELD, "你好");
  await app.compose(FIELD, "zhong");
  await app.keyboard.press("enter");
  await app.wait(200);
  expect(text(app, "asked")).toBe("asked:");
  await app.compose(FIELD, "");

  // Escape is the input method's: the dock stays open.
  await app.compose(FIELD, "wen");
  await app.keyboard.press("escape");
  await app.wait(200);
  expect(text(app, "open")).toBe("open:true");
  await app.compose(FIELD, "");
  // What Return and Escape do to the marked letters is the input method's
  // (macOS commits them as typed); the app took neither key.
  expect(text(app, "value").startsWith("value:你好")).toBe(true);
  expect(text(app, "asked")).toBe("asked:");
  assertGuarded(guard);
});

test("the recipient editor takes Chinese names, and Enter in it sends nothing", async () => {
  const { app, guard } = await openGuarded(APP, { width: 1100, height: 760 });
  await app.waitFor("Send email");
  await app.press("Edit recipients");
  await app.waitFor("Done editing recipients");
  await app.compose("label:To", "zhang");
  expect(app.texts().some((t) => t.includes("To: Bob <bob@example.com>"))).toBe(true);
  await app.compose("label:To", "");
  await app.clear("label:To");
  await app.type("label:To", "张三 <zhang@example.com>");
  await app.waitUntil(() => app.texts().some((t) => t.includes("To: 张三 <zhang@example.com>")));
  await app.keyboard.press("enter");
  await app.wait(100);
  expect(text(app, "asked")).toBe("asked:");
  assertGuarded(guard);
});
