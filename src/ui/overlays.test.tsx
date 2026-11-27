// Escape on the ui overlays: an Escape an input method takes (mid
// composition) closes nothing; nested overlays close one per Escape, the
// topmost first. Menus, selects, tooltips and the date picker's popup hold
// no ui text field, so no ui composition can be open in them (a select's
// built-in search is nsh/base's own field; see docs/DESIGN.md).
import { expect, open, test } from "nsh/test";

const APP = "./fixtures/OverlaysApp.tsx";
const SIZE = { width: 720, height: 640, platform: "macos" as const };

async function composeThenEscape(app: Awaited<ReturnType<typeof open>>, field: string, still: string) {
  await app.compose(`id:${field}`, "han");
  await app.keyboard.press("escape");
  await app.wait(150);
  expect(app.texts()).toContain(still);
  // The composition over, Escape closes it.
  await app.compose(`id:${field}`, "");
  await app.keyboard.press("escape");
  await app.waitFor("Open: none");
}

test("a popover stays open on an Escape the input method takes", async () => {
  const app = await open(APP, SIZE);
  await app.press("id:open-pop");
  await app.waitFor("id:pop-field");
  await composeThenEscape(app, "pop-field", "Open: popover");
});

test("a dialog stays open on an Escape the input method takes", async () => {
  const app = await open(APP, SIZE);
  await app.press("id:open-dialog");
  await app.waitFor("id:dlg-field");
  await composeThenEscape(app, "dlg-field", "Open: dialog");
});

test("a sheet stays open on an Escape the input method takes", async () => {
  const app = await open(APP, SIZE);
  await app.press("id:open-sheet");
  await app.waitFor("id:sheet-field");
  await composeThenEscape(app, "sheet-field", "Open: sheet");
});

test("an overlay panel stays open on an Escape the input method takes", async () => {
  const app = await open(APP, SIZE);
  await app.press("id:open-panel");
  await app.waitFor("id:panel-field");
  await composeThenEscape(app, "panel-field", "Open: panel");
});

test("a popover inside a dialog closes on the first Escape, the dialog on the second", async () => {
  const app = await open(APP, SIZE);
  await app.press("id:open-dialog");
  await app.press("id:open-inner");
  await app.waitFor("Open: dialog,inner");
  await app.keyboard.press("escape");
  await app.waitFor("Open: dialog");
  // The popover leaves with a 140ms exit, holding Escape until it is gone.
  await app.wait(300);
  await app.keyboard.press("escape");
  await app.waitFor("Open: none");
});

test("a select open inside a dialog closes on the first Escape, the dialog on the second", async () => {
  const app = await open(APP, SIZE);
  await app.press("id:open-dialog");
  await app.press("id:dlg-select");
  await app.waitFor("role:option[Alpha]");
  await app.keyboard.press("escape");
  await app.waitFor("role:option[Alpha]", { state: "gone" });
  expect(app.texts()).toContain("Open: dialog");
  await app.keyboard.press("escape");
  await app.waitFor("Open: none");
});

test("a dialog closes on Escape from its focused field", async () => {
  const app = await open(APP, SIZE);
  await app.press("id:open-dialog");
  await app.type("id:dlg-field", "x");
  await app.keyboard.press("escape");
  await app.waitFor("Open: none");
});
