// The draft in its own window answers the keys the shell routes there:
// Escape asks before a changed draft goes, Cmd/Ctrl+Enter sends it into the
// (synthetic) outbox. Needs a real desktop: `nsh test --target macos`;
// headless it runs the same steps on the driver's windows.
import { expect, test } from "nsh/test";
import { assertGuarded, openGuarded } from "../../testing/previewGuard";

async function until(check: () => boolean, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("the compose window takes Escape and Cmd/Ctrl+Enter", async () => {
  const { app, guard } = await openGuarded("./fixtures/WindowedApp.tsx", { width: 900, height: 700, platform: "macos" });
  await app.waitFor("Synthetic outbox: 0");
  await app.press("id:open-draft");
  await app.waitFor("id:compose");
  await app.press("id:compose-detach");
  const win = app.window("compose");
  await until(() => win.state()?.focused === true, "the compose window to have the focus");
  expect(app.windowIds()).toContain("compose");
  // The body fills its window down to the footer (content padding 16 above it).
  await until(() => {
    const body = app.layout("id:compose-body");
    const files = app.layout("id:compose-attachments");
    const footer = app.layout("id:compose-footer");
    if (!body || !footer) return false;
    const last = files ? files.y + files.height : body.y + body.height;
    return Math.abs(footer.y - 16 - last) <= 1;
  }, "the body to reach the footer in the compose window");

  await app.type("id:compose-subject", " notes");
  await app.keyboard.press("escape");
  await app.waitFor("Save this draft?");
  try { await win.screenshot(".nsh/shots/compose-window-leave.png"); } catch {}
  await app.press("id:compose-exit-cancel");

  await app.keyboard.press("mod+enter");
  // Into the draft's own mailbox's outbox, and nowhere else.
  await app.waitFor("Synthetic outbox: 1 jane@example.com", { timeout: 5000 });
  // Headless: nothing reached the real native module.
  assertGuarded(guard);
});
