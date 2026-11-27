// On macOS (`nsh test src/ui/roving-macos.test.tsx --target macos`): a
// roving NavList is one Tab stop. Headless runs move no focus with Tab, so
// these return early there.
import { expect, open, test } from "nsh/test";

type App = Awaited<ReturnType<typeof open>>;
async function onPlatform(app: App): Promise<boolean> {
  try {
    await app.screenshot();
    return true;
  } catch (error) {
    if (!String((error as Error).message).includes("real platform")) throw error;
    return false;
  }
}

test("Tab leaves a roving tree in one step and Shift+Tab returns to the row it left", async () => {
  const app = await open("./GalleryApp.tsx", { width: 900, height: 2600 });
  if (!(await onPlatform(app))) return;
  await app.waitFor("id:tree");
  await app.press("id:focus-tree");
  await app.keyboard.press("end");
  await app.waitFor("Tree: travel");
  await app.keyboard.press("tab");
  await app.wait(200);
  await app.keyboard.press("up");
  await app.wait(200);
  expect(app.texts()).toContain("Tree: travel");
  await app.keyboard.press("shift+tab");
  await app.wait(200);
  await app.keyboard.press("home");
  await app.waitFor("Tree: inbox");
});

test("a click on a tree row gives the tree the keyboard: the arrows work at once", async () => {
  const app = await open("./GalleryApp.tsx", { width: 900, height: 2600 });
  if (!(await onPlatform(app))) return;
  await app.waitFor("id:tree");
  await app.press("id:tree-clients");
  await app.waitFor("Tree: clients");
  await app.wait(200);
  await app.keyboard.press("down");
  await app.waitFor("Tree: contoso");
});

test("Tab from a row goes to the next row, never to its quick actions: a long list is not three stops a row", async () => {
  // The lane's actions are for the pointer; screen readers get them as the
  // row's accessibility actions, the keyboard as the keymap and the row menu.
  const app = await open("./GalleryApp.tsx", { width: 900, height: 2600 });
  if (!(await onPlatform(app))) return;
  await app.waitFor("id:row-lane");
  const lane = () => app.viewStyle("id:row-lane-actions")?.opacity;
  await app.press("id:focus-lane-row");
  await app.wait(200);
  expect(lane()).toBe(0);
  // Shift+Tab from the row below lands on the row above itself: Space opens
  // that row and presses no action.
  await app.keyboard.press("shift+tab");
  await app.wait(200);
  await app.keyboard.press("space");
  await app.waitUntil(() => app.accessibility("id:row-lane")?.selected === true);
  expect(app.texts()).toContain("Lane: none");
  expect(app.accessibility("role:button[Unstar]")).toBeFalsy();
  // Tab from it goes straight back to the row below.
  await app.keyboard.press("tab");
  await app.wait(200);
  await app.keyboard.press("space");
  await app.waitUntil(() => app.accessibility("id:row-lane-empty")?.selected === true);
  expect(app.texts()).toContain("Lane: none");
});
