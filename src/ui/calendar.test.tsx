// The ui Calendar against nsh-omarchy's: the same look at base 14, everything
// ×16/14 at 16, and back.
import { expect, open, test } from "nsh/test";

const APP = "./fixtures/CalendarApp.tsx";
const SIZE = { width: 700, height: 520, platform: "linux" as const };

type App = Awaited<ReturnType<typeof open>>;

/** The calendar `id`'s box, its day 15 and weekday Mo, relative to its corner. */
function measure(app: App, id: string) {
  const cal = app.layout(`id:${id}`)!;
  const day = app.layout(`id:${id} >> text:15`)!;
  const next = app.layout(`id:${id} >> text:16`)!;
  const below = app.layout(`id:${id} >> text:22`)!;
  return {
    width: cal.width,
    height: cal.height,
    dayX: day.x - cal.x,
    dayY: day.y - cal.y,
    // A day's cell: the distance to the next column and the next week.
    cellWidth: next.x - day.x,
    cellHeight: below.y - day.y,
    dayFont: app.spanStyle(`id:${id} >> text:15`).fontSize,
    weekdayFont: app.spanStyle(`id:${id} >> text:Mo`).fontSize,
  };
}

async function setBase(app: App, base: string) {
  await app.press(`id:base-size >> text:${base}`);
  const want = base === "16" ? 12 * 16 / 14 : 12;
  for (let i = 0; i < 40 && Math.abs(app.spanStyle("id:ui-cal >> text:15").fontSize - want) > 0.5; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("picking a day reports it and marks it selected", async () => {
  const app = await open(APP, SIZE);
  await app.waitFor("id:ui-cal >> text:15");
  await app.press("id:ui-cal >> text:15");
  await app.waitFor("Picked: 2026-11-15");
  const node = app.accessibility("id:ui-cal")!;
  const selected: string[] = [];
  const walk = (n: typeof node) => {
    if (n.selected) selected.push(String(n.label ?? ""));
    for (const c of n.children ?? []) walk(c);
  };
  walk(node);
  expect(selected.some((l) => l.includes("15"))).toBe(true);
});

test("the calendar keeps its geometry at 14, scales ×16/14 at 16, and comes back", async () => {
  const app = await open(APP, SIZE);
  await app.waitFor("id:ui-cal >> text:15");
  // v2 (docs/DESIGN.md): nsh-omarchy's geometry, weekdays at the 12pt caption size.
  const at14 = measure(app, "ui-cal");
  expect(at14.dayFont).toBe(12);
  expect(at14.weekdayFont).toBe(12);
  expect(at14.width).toBe(250);
  expect(at14.cellWidth).toBe(32);
  expect(at14.cellHeight).toBe(28);

  await setBase(app, "16");
  const at16 = measure(app, "ui-cal");
  const k = 16 / 14;
  expect(Math.abs(at16.dayFont - 12 * k)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(at16.weekdayFont - 12 * k)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(at16.width - 250 * k)).toBeLessThanOrEqual(1);
  expect(Math.abs(at16.cellWidth - 32 * k)).toBeLessThanOrEqual(1);
  expect(Math.abs(at16.cellHeight - 28 * k)).toBeLessThanOrEqual(1);

  await setBase(app, "14");
  expect(measure(app, "ui-cal")).toEqual(at14);
});
