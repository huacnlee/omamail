// On macOS (`nsh test src/features/settings/rail-macos.test.tsx --target macos`):
// the settings rail is one roving list (ui's NavList): the arrows move to a
// section and scroll to it. Headless runs move no keyboard focus, so this
// runs on the platform. The accounts preview reaches no backend.
import { expect, open, test } from "nsh/test";

type App = Awaited<ReturnType<typeof open>>;
/** Whether the app is drawn (a --target run); headless runs return early. */
async function onPlatform(app: App): Promise<boolean> {
  try {
    await app.screenshot();
    return true;
  } catch (error) {
    if (!String((error as Error).message).includes("real platform")) throw error;
    return false;
  }
}

test("the arrows walk the settings rail", async () => {
  const app = await open("../accounts/fixtures/PreviewInk.tsx", { width: 1180, height: 800 });
  if (!(await onPlatform(app))) return;
  await app.press("id:preview-settings");
  await app.waitFor("id:settings-rail-reading");
  await app.press("id:settings-rail-reading");
  await app.waitUntil(() => app.accessibility("id:settings-rail-reading")?.selected === true);
  // A click selects without taking the keyboard focus; Tab past Back enters the rail at the open section.
  await app.keyboard.press("tab");
  await app.wait(200);
  await app.keyboard.press("tab");
  await app.wait(200);
  await app.keyboard.press("down");
  await app.waitUntil(() => app.accessibility("id:settings-rail-notifications")?.selected === true);
  await app.keyboard.press("end");
  await app.waitUntil(() => app.accessibility("id:settings-rail-keyboard")?.selected === true);
  await app.keyboard.press("home");
  await app.waitUntil(() => app.accessibility("id:settings-rail-backend")?.selected === true);
  expect(app.accessibility("id:settings-rail-keyboard")?.selected).toBe(false);
  // The rail is one Tab stop: the next Tab leaves it, and Down is no longer the rail's.
  await app.keyboard.press("tab");
  await app.wait(200);
  await app.keyboard.press("down");
  await app.wait(200);
  expect(app.accessibility("id:settings-rail-backend")?.selected).toBe(true);
});
