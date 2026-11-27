// The overlay panel's keyboard focus on a real desktop: `nsh test --target
// macos src/ui/focus.test.tsx`. Headless there is no window focus to move, so
// the test checks only what the headless runner can (Escape closes it).
import { expect, open, test } from "nsh/test";

const GALLERY = "./GalleryApp.tsx";

async function onRealPlatform(app: { screenshot(path?: string | null): Promise<Uint8Array> }) {
  try {
    await app.screenshot();
    return true;
  } catch (error) {
    if (String((error as Error).message).includes("real platform")) return false;
    throw error;
  }
}

const offset = (app: { texts(): string[] }) => app.texts().find((t) => t.startsWith("Offset: "));

test("an overlay panel takes the focus on open, keeps it, and closes on one Escape", async () => {
  const app = await open(GALLERY, { width: 900, height: 900, platform: "macos" });
  await app.waitFor("id:open-panel");
  await app.press("id:open-panel");
  await app.waitFor("Group 6");
  if (!(await onRealPlatform(app))) {
    await app.keyboard.press("escape");
    await app.waitFor("Group 6", { state: "gone" });
    return;
  }
  // The focus is in the content: the arrows scroll it.
  for (let i = 0; i < 20 && offset(app) === "Offset: 0"; i++) {
    await app.keyboard.press("down");
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(offset(app)).not.toBe("Offset: 0");
  await app.keyboard.press("end");
  await app.waitFor("End of the shortcuts");
  await app.keyboard.press("home");
  await app.waitFor("Offset: 0");
  // Tab goes to Close and back into the content: the focus stays in the panel.
  await app.keyboard.press("tab");
  await app.keyboard.press("tab");
  await app.keyboard.press("pagedown");
  await app.waitUntil(() => offset(app) !== "Offset: 0");
  // With Close focused, its tooltip does not show, and one Escape closes the panel.
  await app.keyboard.press("tab");
  expect(app.texts().some((t) => t.includes("Close") && t.includes("esc"))).toBe(false);
  await app.keyboard.press("escape");
  await app.waitFor("Group 6", { state: "gone" });
  // From the content too.
  await app.press("id:open-panel");
  await app.waitFor("Group 6");
  await app.keyboard.press("escape");
  await app.waitFor("Group 6", { state: "gone" });
});
