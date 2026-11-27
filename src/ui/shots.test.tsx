// Shots of the gallery for review, on a real platform only:
// `nsh test src/ui/shots.test.tsx --target macos`. Headless runs draw
// nothing, so each shot is skipped there.
import { open, test } from "nsh/test";

type App = Awaited<ReturnType<typeof open>>;

/** Takes the shot when the app is drawn (a `--target` run); false headless. */
async function shot(app: App, path: string): Promise<boolean> {
  try {
    await app.screenshot(path);
    return true;
  } catch (error) {
    if (!String((error as Error).message).includes("real platform")) throw error;
    return false;
  }
}

test("lines: structural dividers in ink, paper and Omarchy", async () => {
  const app = await open("./fixtures/LinesApp.tsx", { width: 720, height: 420 });
  await app.waitFor("Status line");
  for (const [mode, name] of [["dark", "ink"], ["light", "paper"], ["omarchy", "omarchy"]] as const) {
    await app.press(`id:mode-${mode}`);
    await app.wait(300);
    if (!(await shot(app, `.nsh/shots/ui-lines-${name}.png`))) return;
  }
});

test("finder: plain field in a focus-within panel, on the popover surface", async () => {
  const app = await open("./fixtures/FinderApp.tsx", { width: 760, height: 560 });
  await app.waitFor("id:open-finder");
  for (const [mode, name] of [["dark", "ink"], ["light", "paper"], ["omarchy", "omarchy"]] as const) {
    await app.press(`id:theme-${mode}`);
    await app.press("id:open-finder");
    await app.waitFor("id:finder-input");
    await app.type("id:finder-input", "ar");
    await app.wait(300);
    if (!(await shot(app, `.nsh/shots/ui-finder-${name}.png`))) return;
    await app.keyboard.press("escape");
    await app.wait(300);
  }
});

test("checkbox: box on the edge, wash past it on hover", async () => {
  const app = await open("./GalleryApp.tsx", { width: 900, height: 2600, platform: "macos" });
  await app.waitFor("id:cb");
  await app.hover("id:cb");
  await app.wait(300);
  await shot(app, ".nsh/shots/ui-checkbox-hover.png");
});

