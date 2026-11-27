// Finder surfaces: the finder Dialog, the titled Popover, Titled's surfaces.
import { expect, open, test } from "nsh/test";

const APP = "./fixtures/FinderApp.tsx";
const SIZE = { width: 820, height: 640 };

type Box = { x: number; y: number; width: number; height: number };
const midY = (b: Box) => b.y + b.height / 2;

test("a finder dialog is a named modal, its title on the top hairline, and Escape closes it", async () => {
  const app = await open(APP, SIZE);
  await app.waitFor("id:open-finder");
  await app.press("id:open-finder");
  await app.waitFor("id:finder-field");
  const dialog = app.accessibility("role:dialog");
  expect(dialog?.label).toBe("Move to");
  // No title block: the title sits on the card's top edge.
  const frame = app.layout("id:finder-card-frame")!;
  const title = app.layout("id:finder-card-title")!;
  expect(Math.abs(midY(title) - frame.y)).toBeLessThanOrEqual(2);
  // The field panel carries its count on its border.
  expect(app.texts()).toContain("3 / 12");
  const count = app.layout("id:finder-field-trailing")!;
  const field = app.layout("id:finder-field-frame")!;
  expect(Math.abs(midY(count) - field.y)).toBeLessThanOrEqual(2);
  await app.keyboard.press("escape");
  await app.waitFor("id:finder-card", { state: "gone" });
  expect(app.accessibility("role:dialog")).toBeFalsy();
});

test("the finder card pads 12 at base 14 and 16/14 as much at 16", async () => {
  const app = await open(APP, SIZE);
  const padding = async () => {
    await app.press("id:open-finder");
    await app.waitFor("id:finder-field");
    const card = app.layout("id:finder-card")!;
    const field = app.layout("id:finder-field")!;
    const pad = field.x - card.x;
    await app.keyboard.press("escape");
    await app.waitFor("id:finder-card", { state: "gone" });
    return pad;
  };
  await app.waitFor("id:base-14");
  expect(await padding()).toBe(12);
  await app.press("id:base-16");
  await app.waitUntil(() => app.layout("id:base-16")!.height > 26);
  expect(Math.abs((await padding()) - 12 * (16 / 14))).toBeLessThanOrEqual(0.5);
  await app.press("id:base-14");
  await app.waitUntil(() => app.layout("id:base-16")!.height === 26);
  expect(await padding()).toBe(12);
});

test("a titled popover sets its title on its border", async () => {
  const app = await open(APP, SIZE);
  await app.waitFor("id:switcher-trigger");
  await app.press("id:switcher-trigger");
  await app.waitFor("Accounts");
  const frame = app.layout("id:switcher-frame-frame")!;
  const title = app.layout("id:switcher-frame-title")!;
  expect(Math.abs(midY(title) - frame.y)).toBeLessThanOrEqual(2);
  expect(app.texts()).toContain("jane@example.com");
});

test("a titled panel's knockout takes the surface it sits on", async () => {
  const app = await open(APP, SIZE);
  await app.waitFor("id:muted-panel");
  await app.waitUntil(() => !!app.viewStyle("id:muted-panel")?.backgroundColor);
  const panel = app.viewStyle("id:muted-panel")!.backgroundColor;
  expect(app.viewStyle("id:muted-panel-title")!.backgroundColor).toBe(panel);
  expect(app.viewStyle("id:dock")!.backgroundColor).toBe(panel);
});

test("Escape from the finder's focused field closes the finder", async () => {
  const app = await open(APP, SIZE);
  await app.waitFor("id:open-finder");
  await app.press("id:open-finder");
  await app.waitFor("id:finder-input");
  await app.type("id:finder-input", "ar");
  await app.keyboard.press("escape");
  await app.waitFor("id:finder-card", { state: "gone" });
});
