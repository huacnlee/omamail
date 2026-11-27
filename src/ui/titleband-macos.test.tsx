// On macOS (`nsh test src/ui/titleband-macos.test.tsx --target macos`): an
// ActionBar under a TitleBar takes a centre press on every item (ActionBar's
// title-band STOPGAP; a Toolbar there takes its first item's only). Headless
// runs have no title band, so they return early.
import { expect, open, test } from "nsh/test";

type App = Awaited<ReturnType<typeof open>>;
async function onPlatform(app: App): Promise<boolean> {
  try {
    await app.screenshot();
    return true;
  } catch (error) {
    if (!String((error as Error).message).includes("real platform")) throw error;
    return false;
  }
}

const hits = (app: App): Record<string, number> =>
  JSON.parse(app.texts().find((t) => t.startsWith("hits="))!.slice(5));

test("every item of an action bar in the title band takes a centre press", async () => {
  const app = await open("./fixtures/TitleBandApp.tsx", { width: 1100, height: 400 });
  if (!(await onPlatform(app))) return;
  await app.waitFor("id:send");
  // The bar is a toolbar to screen readers in either form.
  expect(app.accessibility("id:band-bar")?.role).toBe("toolbar");
  for (const id of ["back", "detach", "ask", "discard", "send"]) {
    await app.press(`id:${id}`);
    await app.waitUntil(() => (hits(app)[id] ?? 0) === 1);
  }
});
