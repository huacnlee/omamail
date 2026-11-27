// Chinese in the header search, through an input method (synthetic fixture,
// no account). While pinyin is marked: Enter picks a candidate rather than
// searching, Escape cancels the composition rather than clearing and leaving
// the field, and no app shortcut runs. A committed CJK query searches whole.
// On macOS (`--target macos`) it also shoots the field mid-composition.
import { expect, open, test } from "nsh/test";

type App = Awaited<ReturnType<typeof open>>;
const SEARCH = "id:header-search";

async function start(): Promise<App> {
  const app = await open("./fixtures/WholeApp.tsx", { width: 1280, height: 800 });
  await app.waitFor("text:Ada Lovelace");
  return app;
}

async function shot(app: App, path: string) {
  try {
    await app.screenshot(path);
  } catch (error) {
    if (!String((error as Error).message).includes("real platform")) throw error;
  }
}

test("Enter while composing picks the candidate; it does not search", async () => {
  const app = await start();
  await app.type(SEARCH, "report ");
  await app.compose(SEARCH, "zhongwen");
  await shot(app, ".nsh/shots/search-cjk-composing.png");
  await app.keyboard.press("enter");
  await app.wait(300);
  // A search would name its query in the list.
  expect((app.texts() as string[]).some((t) => t.startsWith('"report'))).toBe(false);
  // Headless reports the committed value; macOS includes the marked text.
  expect(String(app.value(SEARCH)).startsWith("report ")).toBe(true);
  await app.compose(SEARCH, "");
  // Composition over: Enter searches again (on macOS ending the synthetic
  // composition keeps its text, so the query is "report zhongwen" there).
  await app.keyboard.press("enter");
  await app.waitUntil(() => (app.texts() as string[]).some((t) => t.startsWith('"report')));
});

test("Escape while composing keeps the field and what it holds", async () => {
  const app = await start();
  await app.type(SEARCH, "invoice ");
  await app.compose(SEARCH, "fapiao");
  await app.keyboard.press("escape");
  await app.wait(200);
  // The search's own Escape (clear, then leave) did not run.
  expect(String(app.value(SEARCH)).startsWith("invoice ")).toBe(true);
  await app.compose(SEARCH, "");
  // Composition over: Escape is the app's again and clears the field.
  await app.keyboard.press("escape");
  await app.waitUntil(() => app.value(SEARCH) === "");
});

test("no shortcut runs while composing, and letters typed in the field stay there", async () => {
  const app = await start();
  await app.compose(SEARCH, "c");
  await app.keyboard.press("c");
  await app.keyboard.press("shift+/");
  await app.wait(200);
  expect(app.shows("id:compose")).toBe(false);
  expect(app.shows("id:shortcut-help-content")).toBe(false);
  await app.compose(SEARCH, "");
  await app.type(SEARCH, "ce");
  await app.wait(200);
  // Keys pressed in the field went to the field, not to the shortcuts.
  expect(String(app.value(SEARCH)).endsWith("ce")).toBe(true);
  expect(app.shows("id:compose")).toBe(false);
  expect(app.shows("text:Ada Lovelace")).toBe(true);
});

test("a committed CJK query searches whole", async () => {
  const app = await start();
  await app.compose(SEARCH, "zhongwen");
  await app.compose(SEARCH, "");
  await app.type(SEARCH, "中文");
  expect(app.value(SEARCH)).toBe("中文");
  await app.keyboard.press("enter");
  // The search runs on the whole committed query (the list names it in quotes).
  await app.waitFor('text:"中文"');
});
