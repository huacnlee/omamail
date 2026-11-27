// The calendar on its synthetic fixture, in light and dark. Headless, every
// export of omamail-native is a failing stand-in, so the test proves the
// fixture reaches nothing on this machine. With `--target macos` the page is
// drawn: the keyboard checks run there (real focus moves between views) and
// each palette is shot.
import { expect, test } from "nsh/test";
import { assertGuarded, openGuarded } from "../../testing/previewGuard";

type Opened = Awaited<ReturnType<typeof openGuarded>>;
type App = Opened["app"];

const SHOTS = ".nsh/shots";

/** Whether the app is drawn (a `--target` run). */
async function drawn(app: App): Promise<boolean> {
  try {
    await app.screenshot();
    return true;
  } catch (error) {
    if (!String((error as Error).message).includes("real platform")) throw error;
    return false;
  }
}

type Node = { label?: string | null; children: Node[] };
/** Every accessibility label in the tree, in order. */
function labels(node: Node | null): string[] {
  if (!node) return [];
  return [...(node.label ? [node.label] : []), ...node.children.flatMap(labels)];
}

/**
 * Settings → Calendars shares the settings spines: every row's title starts
 * on one line, and every control (Show, Unified, the pickers) ends on the
 * rows' right edge.
 */
function expectSharedSpines(app: App) {
  const at = (selector: string) => {
    const box = app.layout(selector);
    if (!box) throw new Error("not on screen: " + selector);
    return box;
  };
  const titles = ["Primary", "Team", "Home", "Unified calendar view", "Default calendar"].map((t) => at("text:" + t + " >> nth=0").x);
  for (const x of titles) expect(Math.abs(x - titles[0]!)).toBeLessThan(0.5);
  const row = at("id:calendar-unified-view-row");
  const end = row.x + row.width;
  for (const selector of ["id:calendar-unified-view", "id:calendar-source-toggle >> nth=0", "id:calendar-source-toggle >> nth=1",
    "id:calendar-source-toggle >> nth=2", "id:invitation-calendar-picker"]) {
    const box = at(selector);
    expect(Math.abs(box.x + box.width - end)).toBeLessThan(0.5);
  }
  for (const n of [0, 1, 2]) {
    const source = at("id:calendar-source-setting >> nth=" + n);
    expect(Math.abs(source.x + source.width - end)).toBeLessThan(0.5);
  }
}

async function key(app: App, keys: string) {
  await app.keyboard.press(keys);
  await app.wait(80);
}

/** Tabs until Return opens an event's detail, at most `limit` stops. */
async function tabToEvent(app: App, limit: number, activate: string): Promise<boolean> {
  for (let i = 0; i < limit; i++) {
    await key(app, "shift+tab");
    const label = app.texts().join("|");
    await key(app, activate);
    if (app.shows("id:calendar-event-detail")) return true;
    // Whatever else the key pressed (a day cell, a toolbar button) is put back.
    if (app.shows("text:Create event")) await key(app, "escape");
    if (app.texts().join("|") !== label) return false;
  }
  return false;
}

for (const [name, entry] of [["light", "./testing/LightHarness.tsx"], ["dark", "./testing/DarkHarness.tsx"]] as const) {
  test("the fixture draws the week, month and agenda in " + name + " without reaching the backend", async () => {
    const { app, guard } = await openGuarded(entry, { width: 1100, height: 800 });
    await app.waitFor("id:calendar-view");
    await app.press("text:Week");
    await app.waitFor("text:Design review");
    const real = await drawn(app);
    if (real) await app.screenshot(SHOTS + "/calendar-week-" + name + ".png");

    await app.press("text:Design review");
    await app.waitFor("id:calendar-event-detail");
    await app.waitFor("text:Bring the sketches");
    if (real) await app.screenshot(SHOTS + "/calendar-detail-" + name + ".png");
    await app.keyboard.press("escape");
    await app.waitUntil(() => !app.shows("id:calendar-event-detail"));

    await app.press("text:Month");
    await app.waitFor("id:calendar-month");
    if (real) await app.screenshot(SHOTS + "/calendar-month-" + name + ".png");
    await app.press("text:Agenda");
    await app.waitFor("text:Lunch with Ann");
    if (real) await app.screenshot(SHOTS + "/calendar-agenda-" + name + ".png");
    await app.press("id:calendar-new-event");
    await app.waitFor("text:Create event");
    if (real) await app.screenshot(SHOTS + "/calendar-composer-" + name + ".png");
    assertGuarded(guard);
  });
}

test("on a real platform Tab reaches an event and Return or Space opens it", async () => {
  const { app, guard } = await openGuarded("./testing/LightHarness.tsx", { width: 1100, height: 800 });
  await app.waitFor("id:calendar-view");
  if (!(await drawn(app))) return; // Headless runs move no focus between views.
  await app.press("text:Week");
  await app.waitFor("text:Design review");
  // Shift+Tab from the end walks back through the timeline's cards first.
  expect(await tabToEvent(app, 12, "enter")).toBe(true);
  await app.screenshot(SHOTS + "/calendar-keyboard-detail.png");
  await key(app, "escape");
  await app.press("text:Agenda");
  await app.waitFor("text:Lunch with Ann");
  expect(await tabToEvent(app, 12, "space")).toBe(true);
  assertGuarded(guard);
});

test("Settings → Calendars lists the calendars and changes them only in memory", async () => {
  const { app, guard } = await openGuarded("./testing/SettingsHarness.tsx", { width: 900, height: 1000 });
  await app.waitFor("id:calendar-settings");
  await app.waitFor("text:Team");
  await app.waitFor("text:Other calendars");
  await app.waitFor("text:Home");
  await app.waitFor("id:invitation-calendar-picker");
  expectSharedSpines(app);
  const real = await drawn(app);
  if (real) await app.screenshot(SHOTS + "/calendar-settings-light.png");
  await app.scroll("id:calendar-settings-scroll", 800);
  await app.waitFor("id:calendar-client-setup");
  if (real) await app.screenshot(SHOTS + "/calendar-settings-end-light.png");
  await app.scroll("id:calendar-settings-scroll", -2000);

  // A color: the swatch opens the picker, a slot saves (in memory) and closes it.
  await app.press("id:calendar-source-color >> nth=0");
  await app.waitFor("id:calendar-color-picker");
  await app.press("id:calendar-color-yellow");
  await app.waitUntil(() => !app.shows("id:calendar-color-picker"));
  await app.waitFor("text:Calendar saved");

  // The CalDAV form opens and cancels without saving anything.
  await app.press("id:calendar-connect-caldav");
  await app.waitFor("id:calendar-caldav-form");
  await app.press("text:Cancel");
  await app.waitUntil(() => !app.shows("id:calendar-caldav-form"));
  assertGuarded(guard);
});

for (const [name, calendar, settings] of [
  ["light", "./testing/Base16Light.tsx", "./testing/Base16SettingsLight.tsx"],
  ["dark", "./testing/Base16Dark.tsx", "./testing/Base16SettingsDark.tsx"],
] as const) {
  test("at base size 16 the week, month and settings draw in " + name + " without reaching the backend", async () => {
    const { app, guard } = await openGuarded(calendar, { width: 1100, height: 800 });
    await app.waitFor("id:calendar-view");
    await app.press("text:Week");
    await app.waitFor("text:Design review");
    const real = await drawn(app);
    if (real) await app.screenshot(SHOTS + "/calendar-week-base16-" + name + ".png");
    await app.press("text:Month");
    await app.waitFor("id:calendar-month");
    if (real) await app.screenshot(SHOTS + "/calendar-month-base16-" + name + ".png");
    assertGuarded(guard);

    const opened = await openGuarded(settings, { width: 900, height: 1000 });
    await opened.app.waitFor("text:Other calendars");
    if (real) await opened.app.screenshot(SHOTS + "/calendar-settings-base16-" + name + ".png");
    assertGuarded(opened.guard);
  });
}

// Visual language v2: Omamail's palettes (Ink, Paper) and an Omarchy
// desktop's (Tokyo Night, Flexoki Light), each at base size 14 and 16: the
// week, an event's detail, the month, the editor and Settings → Calendars.
for (const palette of ["ink", "paper", "tokyo-night", "flexoki-light"] as const) {
  for (const base of ["14", "16"] as const) {
    test(`v2: the calendar in ${palette} at base ${base}`, async () => {
      const storage = { "calendar.palette": palette, "calendar.base": base, "calendar.page": "calendar" };
      const { app, guard } = await openGuarded("./testing/Stored.tsx", { width: 1100, height: 800, storage });
      await app.waitFor("id:calendar-view");
      await app.press("text:Week");
      await app.waitFor("text:Design review");
      const real = await drawn(app);
      const name = (view: string) => `${SHOTS}/v2/calendar-${view}-${palette}-${base}.png`;
      if (real) await app.screenshot(name("week"));
      await app.press("text:Design review");
      await app.waitFor("text:Bring the sketches");
      if (real) await app.screenshot(name("detail"));
      await app.keyboard.press("escape");
      await app.waitUntil(() => !app.shows("id:calendar-event-detail"));
      await app.press("text:Month");
      await app.waitFor("id:calendar-month");
      if (real) await app.screenshot(name("month"));
      await app.press("id:calendar-new-event");
      await app.waitFor("text:Create event");
      if (real) await app.screenshot(name("composer"));
      assertGuarded(guard);

      const settings = { ...storage, "calendar.page": "settings" };
      const opened = await openGuarded("./testing/Stored.tsx", { width: 900, height: 1000, storage: settings });
      await opened.app.waitFor("text:Other calendars");
      if (real) await opened.app.screenshot(name("settings"));
      assertGuarded(opened.guard);
    });
  }
}

// Chinese input on a real platform: the editor's title mid-composition (shot).
test("on a real platform the editor shows pinyin marked, and Enter or Escape while composing stay with it", async () => {
  const { app, guard } = await openGuarded("./testing/LightHarness.tsx", { width: 1100, height: 800 });
  await app.waitFor("id:calendar-view");
  if (!(await drawn(app))) return; // the headless half is cjk.test.tsx
  await app.press("id:calendar-new-event");
  await app.waitFor("id:event-composer");
  await app.type("id:event-title-field", "季度");
  // macOS reports the field's text with the marked pinyin in it; the
  // headless half checks the value stays as committed.
  await app.compose("id:event-title-field", "gui hua");
  await app.screenshot(SHOTS + "/calendar-cjk-composing.png");
  // Escape and Enter go to the input method, not to Cancel or Save. Each
  // ends the composition on a real platform, so each gets its own.
  await app.keyboard.press("escape");
  await app.wait(150);
  expect(app.shows("id:event-composer")).toBe(true);
  await app.compose("id:event-title-field", "gui hua");
  await app.keyboard.press("enter");
  await app.wait(150);
  expect(app.shows("id:event-composer")).toBe(true);
  await app.compose("id:event-title-field", "");
  assertGuarded(guard);
});

test("a card's elided time is whole in its tooltip and accessible label", async () => {
  const { app, guard } = await openGuarded("./testing/LightHarness.tsx", { width: 1100, height: 800 });
  await app.waitFor("id:calendar-view");
  await app.press("text:Week");
  await app.waitFor("text:Overlap A");
  // "14:00–15:00", whatever the hour cycle: both ends, then the calendar.
  const label = labels(app.accessibility() as Node).find((l) => l.startsWith("Overlap A, "));
  expect(label).toBeDefined();
  expect(label!).toMatch(/^Overlap A, .*(14:00|2:00).*[–-].*(15:00|3:00).*, .+$/);
  assertGuarded(guard);
});

test("the top hour in view keeps its label, and every column ends before the scrollbar", async () => {
  const { app, guard } = await openGuarded("./testing/LightHarness.tsx", { width: 1100, height: 800 });
  await app.waitFor("id:calendar-view");
  await app.press("text:Week");
  await app.waitFor("text:Conference");
  // The timeline opens on 08:00 at its top edge: its label shows, inside the grid.
  const scroll = app.layout("id:calendar-time-scroll")!;
  const eight = app.texts().find((t) => /^0?8:00( AM)?$/.test(t));
  expect(eight).toBeDefined();
  expect(app.layout("text:" + eight)!.y).toBeGreaterThanOrEqual(scroll.y - 0.5);
  // The all-day bar ends where the grid's last column does, before the gutter.
  const conference = labels(app.accessibility() as Node).find((l) => l.startsWith("Conference, "))!;
  const bar = app.layout("label:" + conference)!;
  const lane = app.layout("id:calendar-all-day")!;
  expect(bar.x + bar.width).toBeLessThanOrEqual(lane.x + lane.width + 0.5);
  expect(lane.x + lane.width).toBeLessThan(scroll.x + scroll.width - 4);
  assertGuarded(guard);
});
