// The preview fixture must never reach the backend: through the shared guard
// (src/testing/previewGuard.ts) every omamail-native export is recorded, and
// none may run, at module load, on mount or while the preview is used.
import { expect, test } from "nsh/test";
import { assertGuarded, openGuarded } from "../../testing/previewGuard";

test("the mailbox preview asks the backend nothing", async () => {
  const { app, guard } = await openGuarded("./fixtures/PreviewApp.tsx", { width: 560, height: 640, platform: "linux" });
  await app.waitFor("id:label-Clients/Northwind");
  // Folding, a label's list, its menu, the switcher, the rail and the theme.
  await app.press("id:fold-Clients");
  await app.waitFor("id:label-Clients/Northwind", { state: "gone" });
  await app.press("id:label-Bills");
  await app.rightClick("id:label-Travel");
  await app.press("text:Stop monitoring");
  // The finder pickers: a filter, then closed (Escape from the focused field
  // closes them on macOS: finder-macos.test.tsx; headless the field keeps it).
  await app.press("id:open-move-picker");
  await app.waitFor("id:move-picker-field");
  await app.type("id:move-picker-field", "cli");
  await app.waitFor("text:3 / 6");
  await app.back();
  await app.waitFor("id:move-picker-field", { state: "gone" });
  await app.press("id:open-label-picker");
  await app.waitFor("id:label-picker-field");
  await app.back();
  await app.waitFor("id:label-picker-field", { state: "gone" });
  await app.press("id:account-footer");
  await app.waitFor("id:account-switcher-field");
  await app.keyboard.press("escape");
  await app.keyboard.press("[");
  await app.waitFor("text:Bills", { state: "gone" });
  await app.press("id:theme-toggle");
  await app.wait(600);
  assertGuarded(guard);
  expect(app.storage()).toEqual({});
});
