// The body's type is the app's, whatever the sender wrote: a notification
// with its own small sizes in layout tables, and a text-only one, both read
// at BODY_SIZE scaled with Omarchy's base size. Synthetic fixtures; shots on
// a real platform only (`--target macos`).
import { expect, open, test } from "nsh/test";
import { assertGuarded, openGuarded } from "../../testing/previewGuard";
import { SMALL_TYPE_LINES } from "./fixtures/sample";

type App = Awaited<ReturnType<typeof open>>;

async function shot(app: App, path: string) {
  try {
    await app.screenshot(path);
  } catch (error) {
    if (!String((error as Error).message).includes("real platform")) throw error;
  }
}

/** Body.tsx's BODY_SIZE (body.test.ts holds it there): not imported, because
 * Body pulls in the ui layer, which a `--target` test runner cannot load. */
const BODY_SIZE = 15;
/** BODY_SIZE at a base size, as `scaled` makes it (14 is 1:1). */
const bodyAt = (base: number) => Math.round((BODY_SIZE * base) / 14);

for (const base of [14, 16]) {
  test(`the sender's small sizes and layout tables read at the body size, base ${base}`, async () => {
    const storage = { "preview.palette": "ink", "preview.base": String(base), "preview.small": "1" };
    const { app, guard } = await openGuarded("./fixtures/Preview.tsx", { width: 1000, height: 820, storage });
    await app.waitFor("text:A new key was added");
    await app.waitFor("id:message-body-text");
    const body = bodyAt(base);
    for (const line of SMALL_TYPE_LINES.slice(0, 3)) {
      const style = app.spanStyle(`text:${line}`);
      // The sender's 11px, 12px and <font size=1> are gone: the body's size, regular.
      expect(style.fontSize).toBe(body);
      expect(style.fontWeight).toBe(400);
    }
    // <small> stays smaller, but never under the zoom floor's size.
    const small = app.spanStyle(`text:${SMALL_TYPE_LINES[3]}`).fontSize;
    expect(small).toBeLessThan(body);
    expect(small).toBeGreaterThanOrEqual(Math.round(body * 0.8));
    // A table with a header row is data: it stays a table, its cells regular.
    expect(app.shows("text:Key")).toBe(true);
    expect(app.spanStyle("text:release").fontSize).toBe(body);
    await shot(app, `.nsh/shots/v2/reader-small-type-ink-${base}.png`);
    assertGuarded(guard);
  });

  test(`a text-only message reads at the body size, base ${base}`, async () => {
    const storage = { "preview.palette": "paper", "preview.base": String(base), "preview.plain": "1" };
    const { app, guard } = await openGuarded("./fixtures/Preview.tsx", { width: 1000, height: 820, storage });
    await app.waitFor("text:A new key was added");
    await app.waitFor("text:https://example.com/widgets/settings/keys");
    expect(app.spanStyle("text:https://example.com/widgets/settings/keys").fontSize).toBe(bodyAt(base));
    // Text only: no Reader/Original/Plain to choose between.
    expect(app.shows("id:reader-mode")).toBe(false);
    await shot(app, `.nsh/shots/v2/reader-plain-only-paper-${base}.png`);
    assertGuarded(guard);
  });
}

test("a zoomed body shows its zoom in the bar, which resets it", async () => {
  const storage = { "preview.palette": "ink", "preview.base": "14", "preview.plain": "1", "preview.zoom": "0.8" };
  const { app, guard } = await openGuarded("./fixtures/Preview.tsx", { width: 1000, height: 820, storage });
  await app.waitFor("id:reader-zoom");
  expect(app.shows("text:80%")).toBe(true);
  expect(app.spanStyle("text:https://example.com/widgets/settings/keys").fontSize).toBe(12);
  await shot(app, ".nsh/shots/v2/reader-zoom-80-ink-14.png");
  await app.press("id:reader-zoom");
  await app.waitFor("id:reader-zoom", { state: "gone" });
  expect(app.spanStyle("text:https://example.com/widgets/settings/keys").fontSize).toBe(15);
  assertGuarded(guard);
});
