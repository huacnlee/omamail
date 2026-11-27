// The ui DatePicker against nsh-omarchy's: picking a day, and the same
// trigger at base 14, ×16/14 at 16, and back.
import { expect, open, test } from "nsh/test";

const APP = "./fixtures/DatePickerApp.tsx";
const SIZE = { width: 700, height: 520, platform: "linux" as const };

type App = Awaited<ReturnType<typeof open>>;

/** The trigger `id`'s box and its label's place and size. */
function measure(app: App, id: string, text: string) {
  const box = app.layout(`id:${id}`)!;
  const label = app.layout(`id:${id} >> text:${text}`)!;
  return {
    width: box.width,
    height: box.height,
    labelX: label.x - box.x,
    labelY: label.y - box.y,
    font: app.spanStyle(`id:${id} >> text:${text}`).fontSize,
  };
}

async function setBase(app: App, base: string) {
  await app.press(`id:base-size >> text:${base}`);
  const want = base === "16" ? 12 * 16 / 14 : 12;
  for (let i = 0; i < 40 && Math.abs(app.spanStyle("id:ui-set >> text:Nov 19, 2026").fontSize - want) > 0.5; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("the trigger shows the placeholder, then the day picked", async () => {
  const app = await open(APP, SIZE);
  await app.waitFor("id:ui-picker >> text:Choose a date");
  const labels: string[] = [];
  const walk = (n: NonNullable<ReturnType<App["accessibility"]>>) => {
    labels.push(String(n.label ?? ""));
    for (const c of n.children ?? []) walk(c);
  };
  walk(app.accessibility("id:ui-picker")!);
  expect(labels.some((l) => l.includes("Start date"))).toBe(true);
  await app.press("id:ui-picker >> text:Choose a date");
  await app.waitFor("text:15");
  await app.press("text:15");
  await app.waitUntil(() => app.texts().some((t) => /^Picked: \d{4}-\d{2}-15$/.test(t)));
  const picked = app.texts().find((t) => t.startsWith("Picked: "))!;
  const iso = /(\d{4})-(\d{2})-15/.exec(picked)!;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  await app.waitFor(`id:ui-picker >> text:${months[Number(iso[2]) - 1]} 15, ${iso[1]}`);
});

test("the trigger is a field at 14 (as tall as an Input), scales ×16/14 at 16, and comes back", async () => {
  const app = await open(APP, SIZE);
  await app.waitFor("id:ui-set >> text:Nov 19, 2026");
  const at14 = measure(app, "ui-set", "Nov 19, 2026");
  // It fills its column, which is nsh-omarchy's 240pt.
  expect(at14.width).toBe(240);
  expect(at14.height).toBe(30);
  expect(at14.font).toBe(13);

  await setBase(app, "16");
  const at16 = measure(app, "ui-set", "Nov 19, 2026");
  const k = 16 / 14;
  expect(Math.abs(at16.width - 240 * k)).toBeLessThan(1);
  // Whole points, as Input's.
  expect(at16.height).toBe(Math.round(Math.round(30 * k * 2) / 2));
  expect(Math.abs(at16.font - 13 * k)).toBeLessThan(0.6);
  expect(Math.abs(at16.labelX - at14.labelX * k)).toBeLessThan(1);

  await setBase(app, "14");
  expect(measure(app, "ui-set", "Nov 19, 2026")).toEqual(at14);
});

test("the trigger fits its slot beside a fixed field at 14 and 16, the chevron inside it", async () => {
  const app = await open(APP, SIZE);
  await app.waitFor("id:ui-slot >> text:Nov 19, 2026");
  for (const base of ["14", "16"]) {
    await setBase(app, base);
    const k = Number(base) / 14;
    const row = app.layout("id:ui-slot-row")!;
    const trigger = app.layout("id:ui-slot")!;
    const time = app.layout("id:ui-time")!;
    const label = app.layout("id:ui-slot >> text:Nov 19, 2026")!;
    const right = trigger.x + trigger.width;
    // The row does not grow with the base size; the slot takes what is left.
    expect(trigger.x).toBeGreaterThanOrEqual(row.x - 0.5);
    expect(time.x + time.width).toBeLessThanOrEqual(row.x + row.width + 0.5);
    // The row's 8pt gap stays between the trigger and the time field.
    expect(Math.abs(time.x - right - 8)).toBeLessThan(0.5);
    // The label ends a gap and a 14pt chevron before the trigger's right edge,
    // less the 12pt padding: the chevron is drawn inside the trigger.
    const room = right - (label.x + label.width);
    expect(room).toBeGreaterThanOrEqual(Math.floor(8 * k + 14 * k + 12 * k) - 1);
  }
});
