// On macOS (`nsh test src/features/mailbox/cjk-macos.test.tsx --target macos`):
// the offline preview's account switcher mid-composition, the marked text
// shot for review. Synthetic data only; `modules` stand-ins do not run on a
// target, and the preview reaches no backend.
import { expect, open, test } from "nsh/test";

type App = Awaited<ReturnType<typeof open>>;
/** Whether the app is drawn (a --target run). Headless runs return early: these check the platform's own focus, input method and drawing. */
async function onPlatform(app: App): Promise<boolean> {
  try {
    await app.screenshot();
    return true;
  } catch (error) {
    if (!String((error as Error).message).includes("real platform")) throw error;
    return false;
  }
}

const SHOTS = "/private/tmp/claude-502/-Users-jason-work-omamail/c8bd6bb3-e2df-4ada-abeb-5e45ccf6abb6/scratchpad/cjk";

test("the switcher's filter mid-composition, then Return", async () => {
  const app = await open("./fixtures/PreviewApp.tsx", { width: 560, height: 640 });
  if (!(await onPlatform(app))) return;
  await app.waitFor("id:label-Bills");
  await app.press("id:account-footer");
  await app.waitFor("id:account-switcher-field");
  await app.compose("id:account-switcher-field", "sam");
  await app.wait(300);
  await app.screenshot(`${SHOTS}/switcher-composing.png`);
  await app.keyboard.press("enter");
  await app.wait(300);
  // Return picked the candidate: the switcher stays open on the open account.
  expect(app.shows("id:account-switcher-field")).toBe(true);
  expect(app.accessibility("id:account-footer")?.label?.startsWith("Ada Example")).toBe(true);
});

test("Escape mid-composition cancels the composition, not the switcher", async () => {
  const app = await open("./fixtures/PreviewApp.tsx", { width: 560, height: 640 });
  if (!(await onPlatform(app))) return;
  await app.waitFor("id:label-Bills");
  await app.press("id:account-footer");
  await app.waitFor("id:account-switcher-field");
  await app.compose("id:account-switcher-field", "sam");
  await app.keyboard.press("escape");
  await app.wait(300);
  expect(app.shows("id:account-switcher-field")).toBe(true);
});
