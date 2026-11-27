// On macOS (`nsh test src/features/mailbox/roving-macos.test.tsx --target macos`):
// the sidebar is one Tab stop, and the arrows move the selection itself
// (ui's NavList roving). Headless runs move no focus with Tab, so this runs on the
// platform. Synthetic data only; the preview reaches no backend.
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

test("Tab enters the sidebar at the open row; the arrows open rows; Left and Right fold and step in", async () => {
  const app = await open("./fixtures/PreviewApp.tsx", { width: 760, height: 640 });
  if (!(await onPlatform(app))) return;
  await app.waitFor("id:label-Bills");
  await app.keyboard.press("tab");
  await app.wait(200);
  await app.keyboard.press("down");
  await app.waitUntil(() => app.accessibility("id:mailbox-unread")?.selected === true);
  await app.keyboard.press("down");
  await app.waitUntil(() => app.accessibility("id:mailbox-starred")?.selected === true);
  await app.keyboard.press("up");
  await app.waitUntil(() => app.accessibility("id:mailbox-unread")?.selected === true);
  await app.keyboard.press("end");
  await app.waitUntil(() => app.accessibility("id:label-Travel")?.selected === true);
  // Travel, Receipts, Launch; 2026 and Projects take the focus without opening; Northwind, Contoso, Clients.
  for (let i = 0; i < 7; i++) {
    await app.keyboard.press("up");
    await app.wait(100);
  }
  await app.waitUntil(() => app.accessibility("id:label-Clients")?.selected === true);
  await app.keyboard.press("left");
  await app.waitFor("id:label-Clients/Northwind", { state: "gone" });
  expect(app.accessibility("id:label-Clients")?.selected).toBe(true);
  await app.keyboard.press("right");
  await app.waitFor("id:label-Clients/Northwind");
  await app.keyboard.press("right");
  await app.waitUntil(() => app.accessibility("id:label-Clients/Contoso")?.selected === true);
  // Tab leaves the sidebar: Down is no longer the sidebar's.
  await app.keyboard.press("tab");
  await app.wait(200);
  await app.keyboard.press("down");
  await app.wait(200);
  expect(app.accessibility("id:label-Clients/Contoso")?.selected).toBe(true);
});
