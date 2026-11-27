// Whole-app acceptance shots: every scene of the synthetic fixture in Ink,
// Paper and Omarchy (tokyo-night), at base size 14 and 16, wide and
// one-column, and a Tab walk across the panes. Run with --target macos;
// headless runs skip (nothing is drawn). Synthetic data only.
import { open, test } from "nsh/test";

type App = Awaited<ReturnType<typeof open>>;
// Where the shots go: .nsh/shots/whole by default.
const DIR = ".nsh/shots/whole-";

/** Whether the app is drawn (a --target run); headless the shots are skipped. */
async function drawn(app: App): Promise<boolean> {
  try {
    await app.screenshot();
    return true;
  } catch (error) {
    if (!String((error as Error).message).includes("real platform")) throw error;
    return false;
  }
}
async function k(app: App, keys: string, ms = 500) { await app.keyboard.press(keys); await app.wait(ms); }
async function shot(app: App, name: string) { await app.wait(400); await app.screenshot(DIR + name + ".png"); }

async function home(app: App) { await k(app, "mod+shift+h", 700); }
async function scenes(app: App, tag: string) {
  await home(app);
  await k(app, "enter", 600);
  await k(app, "mod+shift+o", 800);
  await shot(app, tag + "-1-mail");
  await k(app, "alt+g", 1000);
    await shot(app, tag + "-2-assistant");
  await home(app);
  await k(app, "c", 900);
  await shot(app, tag + "-3-compose");
  if (app.shows("id:compose-detach")) {
    await app.press("id:compose-detach");
    await app.wait(1500);
    try { await app.window("compose").screenshot(DIR + tag + "-4-compose-window.png"); } catch {}
  }
  await home(app);
  await app.wait(600);
  await k(app, "alt+c", 1200);
  await k(app, "w", 800);
  await shot(app, tag + "-5-calendar");
  await home(app);
  await k(app, "mod+,", 1000);
  await shot(app, tag + "-6-settings");
  await home(app);
  await k(app, "shift+/", 900);
  await shot(app, tag + "-9-help");
  await k(app, "escape", 600);
  await home(app);
  await app.setViewport(640, 800);
  await app.wait(500);
  await shot(app, tag + "-8-narrow-list");
  await k(app, "enter", 600);
  await k(app, "mod+shift+o", 800);
  await shot(app, tag + "-7-narrow-reader");
  await app.setViewport(1280, 800);
  await app.wait(600);
}

test("tab walk", async () => {
  const app = await open("./WholeApp.tsx", { platform: "macos" });
  if (!(await drawn(app))) return;
  await app.waitFor("text:Ada Lovelace");
  await app.wait(800);
  await k(app, "enter", 600);
  await k(app, "mod+shift+o", 800);
  await k(app, "alt+g", 900);
  for (let i = 1; i <= 60; i++) { await k(app, "tab", 200); await app.screenshot(DIR + "tab-" + String(i).padStart(2, "0") + ".png"); }
}, 600000);

test("whole app", async () => {
  const app = await open("./WholeApp.tsx", { platform: "macos" });
  if (!(await drawn(app))) return;
  await app.waitFor("text:Ada Lovelace");
  await app.wait(800);
  // Ink, Paper and Omarchy (tokyo-night), at base size 14 and then 16.
  for (const [size, key] of [["14", "mod+shift+n"], ["16", "mod+shift+b"]]) {
    await k(app, key, 800);
    await k(app, "mod+shift+i", 800);
    await scenes(app, "ink" + size);
    await k(app, "mod+shift+p", 800);
    await scenes(app, "paper" + size);
    await k(app, "mod+shift+d", 900);
    await scenes(app, "omarchy" + size);
  }
}, 1200000);

// The detached compose window, at base size 16 in each theme. Its failures
// are reported, not swallowed: a missing shot is a finding.
test("compose window at 16", async () => {
  const app = await open("./WholeApp.tsx", { platform: "macos" });
  if (!(await drawn(app))) return;
  await app.waitFor("text:Ada Lovelace");
  await app.wait(800);
  await k(app, "mod+shift+b", 800);
  for (const [theme, key] of [["ink", "mod+shift+i"], ["paper", "mod+shift+p"], ["omarchy", "mod+shift+d"]]) {
    await k(app, key, 900);
    await home(app);
    await k(app, "c", 900);
    await app.waitFor("id:compose-detach");
    // The pointer comes over the button first, as a user's does: compose's
    // title-bar stopgap releases To on that (ComposeView.tsx).
    await app.hover("id:compose-detach");
    await app.press("id:compose-detach");
    await app.waitUntil(() => app.windowIds().includes("compose"), { timeout: 5000 });
    await app.wait(1200);
    await app.window("compose").screenshot(DIR + theme + "16-4-compose-window.png");
    await app.window("compose").pressClose();
    await app.waitUntil(() => !app.windowIds().includes("compose"), { timeout: 5000 });
    await app.wait(600);
  }
}, 600000);
