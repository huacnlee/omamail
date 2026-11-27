// STOPGAP (ComposeView.tsx releaseFieldFocus; remove with it): with a compose
// field focused, a button in the inline compose header still takes the
// pointer's press. NSH issue draft: docs/NSH-PORT.md, "NSH issue: title-bar
// presses lost while a field is focused". Runs headless and with --target
// macos, where the press is otherwise lost; fails on macOS without the stopgap.
import { expect, open, test } from "nsh/test";

test("pointing at the compose header while To is focused releases it, and the press lands", async () => {
  const app = await open("../../shell/fixtures/WholeApp.tsx", { width: 1280, height: 800, platform: "macos" });
  await app.waitFor("text:Ada Lovelace");
  await app.keyboard.press("c");
  await app.waitFor("id:compose-to");
  // A new message opens with To focused; what is typed lands there.
  await app.keyboard.press("q");
  await app.waitUntil(() => app.value("id:compose-to") === "q");
  await app.hover("id:compose-back");
  await app.press("id:compose-back");
  // The draft changed, so Back asks first: the press landed.
  await app.waitFor("text:Save this draft?");
  // The field let go of the keyboard but kept its text.
  expect(app.value("id:compose-to")).toBe("q");
});
