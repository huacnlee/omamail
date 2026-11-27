// The outlined ToolButton: the ghost's box with its border drawn at rest. The
// border colour is not in `viewStyle`, so the look is the macOS shot; these
// check that outline changes nothing else.
import { expect, open, test } from "nsh/test";

const APP = "./fixtures/OutlineApp.tsx";
const SIZE = { width: 520, height: 260 };

test("an outlined tool button is the ghost's size, icon and all", async () => {
  const app = await open(APP, SIZE);
  await app.waitFor("id:outlined");
  const ghost = (await app.layout("id:ghost"))!;
  const outlined = (await app.layout("id:outlined"))!;
  const plain = (await app.layout("id:outlined-plain"))!;
  expect(outlined.height).toBe(ghost.height);
  expect(outlined.width).toBe(ghost.width);
  // The paperclip takes room: without it the same label is narrower.
  expect(plain.width).toBeLessThan(outlined.width);
  expect(plain.height).toBe(outlined.height);
});

test("an outlined icon-only tool button stays square", async () => {
  const app = await open(APP, SIZE);
  const box = (await app.layout("id:outlined-icon"))!;
  expect(box.width).toBe(box.height);
});

test("an outlined toggle presses, relabels and shows its selected state", async () => {
  const app = await open(APP, SIZE);
  await app.waitFor("Presses: 0");
  await app.press("id:toggle");
  await app.waitFor("Presses: 1");
  await app.waitFor("Hide");
  expect(app.accessibility("id:toggle")!.selected).toBe(true);
  await app.press("id:toggle");
  await app.waitFor("Presses: 2");
  await app.waitFor("Show");
  expect(app.accessibility("id:toggle")!.selected).toBe(false);
});

/** Takes the shot when the app is drawn (a `--target` run); false headless. */
async function shot(app: Awaited<ReturnType<typeof open>>, path: string): Promise<boolean> {
  try {
    await app.screenshot(path);
    return true;
  } catch (error) {
    if (!String((error as Error).message).includes("real platform")) throw error;
    return false;
  }
}

test("the outlined tool buttons in Ink, Paper and Omarchy", async () => {
  const app = await open(APP, SIZE);
  await app.waitFor("id:outlined");
  await app.press("id:toggle");
  for (const mode of ["dark", "light", "omarchy"]) {
    await app.press(`id:mode-${mode}`);
    if (!(await shot(app, `.nsh/shots/v2/ui-toolbutton-outline-${mode}.png`))) return;
  }
});
