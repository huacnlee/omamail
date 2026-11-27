// Open in window from the app as shipped (the shell's synthetic whole-app
// fixture), on a real platform: the draft moves to a "compose" window.
//
// On macOS a press in a hidden title bar's area is lost while a text field
// has the focus (NSH issue draft: docs/NSH-PORT.md, "NSH issue: title-bar
// presses lost while a field is focused"), and a new message opens with To
// focused. Compose's stopgap (ComposeView.tsx releaseFieldFocus) gives the
// focus up when the pointer enters the header, so the hover below is part of
// the user's path, not a workaround in the test.
//
// The header's ActionBar is a plain row in the title bar's band
// (`inTitleBar`): there an nsh/base Toolbar takes presses on its first item
// only (ui's STOPGAP in ActionBar.tsx; NSH issue draft
// <scratchpad>/nsh-issue-titlebar-press.md, "Second case").
import { expect, open, test } from "nsh/test";

test("Open in window moves the draft to a window of its own (macOS, from the shell)", async () => {
  const app = await open("../../shell/fixtures/WholeApp.tsx", { platform: "macos" });
  await app.keyboard.press("mod+shift+h");
  await app.keyboard.press("c");
  await app.waitFor("id:compose");
  await app.hover("id:compose-detach");
  await app.press("id:compose-detach");
  const end = Date.now() + 5000;
  while (!app.windowIds().includes("compose")) {
    if (Date.now() > end) throw new Error(`no compose window: ${app.windowIds().join(", ")}`);
    await app.wait(100);
  }
  expect(app.windowIds()).toContain("compose");
});
