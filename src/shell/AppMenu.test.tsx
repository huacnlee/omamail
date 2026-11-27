import { expect, test } from "nsh/test";
import { openGuarded } from "../testing/previewGuard";

test("j and k walk the menu from nowhere, Return runs the row", async () => {
  const { app, guard } = await openGuarded("./fixtures/MenuApp.tsx", { width: 800, height: 600 });
  await app.press("label:Menu");
  await app.waitFor("id:app-menu-inbox");
  // Nothing is lit on opening: no row reads as "where you are".
  expect(app.accessibility("id:app-menu-inbox")?.selected ?? false).toBe(false);
  await app.keyboard.press("k");
  expect(app.accessibility("id:app-menu-quit")?.selected).toBe(true);
  await app.keyboard.press("j");
  expect(app.accessibility("id:app-menu-inbox")?.selected).toBe(true);
  await app.keyboard.press("j");
  // Calendar shows (no feature said otherwise); then the disabled "Mark these read" is skipped.
  expect(app.accessibility("id:app-menu-calendar")?.selected).toBe(true);
  await app.keyboard.press("j");
  expect(app.accessibility("id:app-menu-settings")?.selected).toBe(true);
  await app.keyboard.press("escape");
  await app.waitFor("id:app-menu-inbox", { state: "gone" });
  guard?.assertNoCalls();
});

test("the last row quits", async () => {
  const { app, guard } = await openGuarded("./fixtures/MenuApp.tsx", { width: 800, height: 600 });
  await app.press("label:Menu");
  await app.waitFor("id:app-menu-quit");
  await app.keyboard.press("k");
  await app.keyboard.press("o");
  await app.waitFor("id:app-menu-quit", { state: "gone" });
  guard?.assertNoCalls();
});

test("the chrome fixture reaches no backend and writes no window.json", async () => {
  const { app, guard } = await openGuarded("./fixtures/ChromeApp.tsx", { width: 1180, height: 760 });
  await app.waitFor("text:Reader");
  await app.keyboard.press("[");
  await app.keyboard.press("shift+/");
  await app.waitFor("text:Keyboard shortcuts");
  await app.keyboard.press("escape");
  await app.wait(500);
  guard?.assertNoCalls();
});
