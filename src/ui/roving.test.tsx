// The roving focus's focus-out while a move hands the focus on
// (fixtures/RovingProbeApp.tsx plays the event orders by hand).
import { expect, open, test } from "nsh/test";

const APP = "./fixtures/RovingProbeApp.tsx";

test("a focus-out during a move with no focus-in after it counts as leaving: the arrows unbind", async () => {
  const app = await open(APP, { width: 480, height: 320 });
  await app.press("id:in");
  await app.waitFor("Bound: yes");
  // Down, and Tab takes the focus out before the new row takes it.
  await app.press("id:down-away");
  await app.waitFor("Open: b");
  await app.waitFor("Bound: no");
});

test("a move's focus-out before its focus-in (macOS's order) is no leaving: the arrows stay bound", async () => {
  const app = await open(APP, { width: 480, height: 320 });
  await app.press("id:in");
  await app.waitFor("Bound: yes");
  await app.press("id:down-macos");
  await app.waitFor("Open: b");
  await app.wait(200);
  expect(app.texts()).toContain("Bound: yes");
});
