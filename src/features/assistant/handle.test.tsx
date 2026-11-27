// The dock's width handle in the app: drag, keyboard steps (once Tab has
// reached it; a click does not focus it, as on macOS), and the reset.
import { expect, open, test } from "nsh/test";
import { assertGuarded, openGuarded } from "../../testing/previewGuard";

const PREVIEW = "./PreviewApp.tsx";
type App = Awaited<ReturnType<typeof open>>;
const width = (app: App) => app.layout("id:assistant-dock")?.width ?? -1;

async function key(app: App, keys: string) {
  await app.keyboard.press(keys);
  await app.wait(60);
}

/** Whether the app is drawn (a `--target` run): headless runs move no
 * keyboard focus between views, so the key steps are checked there only. */
async function drawn(app: App): Promise<boolean> {
  try {
    await app.screenshot();
    return true;
  } catch (error) {
    if (!String((error as Error).message).includes("real platform")) throw error;
    return false;
  }
}

test("the handle drags, steps by key and resets", async () => {
  const { app, guard } = await openGuarded(PREVIEW, { width: 1100, height: 760 });
  await app.waitFor("Send email");
  // 1100 points: default 420, min 280, max 715 (65%).
  expect(width(app)).toBe(420);

  await app.drag("id:assistant-width", { x: -40, y: 0 });
  await app.wait(100);
  expect(width(app)).toBe(460);

  if (await drawn(app)) {
    // Tab to the handle: the first stop after which Left widens the dock.
    let reached = false;
    for (let i = 0; i < 20 && !reached; i++) {
      await key(app, "tab");
      const before = width(app);
      await key(app, "left");
      reached = width(app) === before + 16;
    }
    expect(reached).toBe(true);
    await app.screenshot(".nsh/shots/assistant-handle-focus.png");
    await key(app, "right");
    expect(width(app)).toBe(460);
    await key(app, "shift+left");
    expect(width(app)).toBe(524);
    await key(app, "home");
    expect(width(app)).toBe(280);
    await key(app, "end");
    expect(width(app)).toBe(715);
    await key(app, "enter");
    expect(width(app)).toBe(420);
    await app.drag("id:assistant-width", { x: -40, y: 0 });
    await app.wait(100);
    expect(width(app)).toBe(460);
  }

  // A double click restores the default.
  await app.press("id:assistant-width");
  await app.press("id:assistant-width");
  await app.wait(100);
  expect(width(app)).toBe(420);
  // Nothing reached the backend, the config files or the system agent.
  assertGuarded(guard);
});

test("the dock's default width grows with Omarchy's base size", async () => {
  const { app, guard } = await openGuarded(PREVIEW, { width: 1400, height: 760 }, { omarchyFont: { family: null, baseSize: 18 } });
  await app.waitFor("Send email");
  // 420 at base 14 is 540 at 18 (under 45% of 1400). Only the guarded run
  // sets the size; on a real platform it is the machine's.
  if (guard.guarded) expect(width(app)).toBe(540);
  assertGuarded(guard);
});
