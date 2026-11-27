// On macOS (`nsh test src/features/mailbox/finder-macos.test.tsx --target macos`):
// the finder pickers and the switcher on the offline preview, shot in Ink,
// Paper and Omarchy at base 14 and 16, and Escape from a picker's focused
// field. Synthetic data only; the preview reaches no backend.
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

const SHOTS = "/private/tmp/claude-502/-Users-jason-work-omamail/c8bd6bb3-e2df-4ada-abeb-5e45ccf6abb6/scratchpad/v2mailbox";

test("Escape from the Move to field closes the picker", async () => {
  const app = await open("./fixtures/PreviewApp.tsx", { width: 760, height: 640 });
  if (!(await onPlatform(app))) return;
  await app.waitFor("id:label-Bills");
  await app.press("id:open-move-picker");
  await app.waitFor("id:move-picker-field");
  await app.type("id:move-picker-field", "cli");
  await app.keyboard.press("escape");
  await app.waitFor("id:move-picker-field", { state: "gone" });
  expect(app.shows("id:label-Bills")).toBe(true);
});

test("shots", async () => {
  const app = await open("./fixtures/PreviewApp.tsx", { width: 760, height: 640 });
  if (!(await onPlatform(app))) return;
  await app.waitFor("id:label-Bills");
  for (const base of [14, 16]) {
    if (base === 16) {
      await app.press("id:base-16");
      await app.wait(300);
    }
    for (const theme of ["ink", "paper", "omarchy"]) {
      await app.wait(300);
      await app.screenshot(`${SHOTS}/${theme}${base}-sidebar.png`);
      await app.press("id:open-move-picker");
      await app.waitFor("id:move-picker-field");
      await app.type("id:move-picker-field", "cli");
      await app.wait(300);
      await app.screenshot(`${SHOTS}/${theme}${base}-move.png`);
      await app.back();
      await app.waitFor("id:move-picker-field", { state: "gone" });
      await app.press("id:account-footer");
      await app.waitFor("id:account-switcher-field");
      await app.wait(300);
      await app.screenshot(`${SHOTS}/${theme}${base}-switcher.png`);
      await app.keyboard.press("escape");
      await app.waitFor("id:account-switcher-field", { state: "gone" });
      await app.press("id:theme-toggle");
    }
  }
});
