// The message row's layout on the synthetic list fixture: the trailing spine
// (every row's time and metadata end on one edge, the quick-action overlay on
// the same one), the thread count as a chip clear of the time, a title that
// does not move when the overlay shows, fixed row heights at base size 14 and
// 16, and the virtual list landing the keyboard cursor on the edge. Headless
// layouts use stand-in font metrics, so the measured cases run only where the
// app is drawn (`nsh test --target macos`); headless they return early.
import { expect, open, test } from "nsh/test";

type App = Awaited<ReturnType<typeof open>>;
type Box = { x: number; y: number; width: number; height: number; hidden?: boolean } | null | undefined;
const right = (b: Box) => (b ? b.x + b.width : NaN);

/** Whether the app is drawn (a --target run). */
async function drawn(app: App): Promise<boolean> {
  try {
    await app.screenshot();
    return true;
  } catch (error) {
    if (!String((error as Error).message).includes("real platform")) throw error;
    return false;
  }
}

async function openFixture(theme: string, size: string, many?: string, wide = false) {
  const storage: Record<string, string> = { "listFixture.theme": theme, "listFixture.baseSize": size };
  if (many) storage["listFixture.many"] = many;
  if (wide) storage["listFixture.wide"] = "1";
  const app = await open("./ListFixture.tsx", { platform: "macos", storage, width: wide ? 600 : 460, height: 620 });
  await app.waitFor(many === "cjk" ? "text:王小明" : many === "unified" ? "text:Northwind Traders shared vendor-contracts mailbox" : "text:Ada Lovelace");
  await app.wait(600);
  return app;
}

for (const theme of ["light", "dark", "omarchy"]) {
  for (const size of ["14", "16"]) {
    test(`rows end on one trailing spine (${theme}, base ${size})`, async () => {
      const k = Number(size) / 14;
      const app = await openFixture(theme, size);
      if (!(await drawn(app))) return;
      const row = app.layout("id:message-row-0") as Box;
      expect(Math.abs((row?.height ?? 0) - 72 * k)).toBeLessThan(1.01);

      const metas = [0, 1, 2, 3, 4, 5].map((i) => app.layout(`id:message-row-${i}-meta`) as Box);
      const spine = right(metas[0]);
      for (const meta of metas) expect(Math.abs(right(meta) - spine)).toBeLessThan(1.01);
      const inset = right(row) - spine;
      expect(inset).toBeGreaterThan(8 * k);
      expect(inset).toBeLessThan(14 * k + 1);

      // The thread count is its own chip, clear of the time; single messages have none.
      const chip = app.layout("id:message-row-1-thread") as Box;
      expect(!!chip && !chip.hidden).toBe(true);
      expect(spine - right(chip)).toBeGreaterThan(24 * k);
      expect(app.layout("id:message-row-0-thread")).toBeFalsy();

      // Hover: the overlay ends on the same spine, and the title stays put.
      const before = app.layout("text:Compiler review on Thursday") as Box;
      await app.hover("text:Grace Hopper");
      await app.wait(400);
      const actions = app.layout("id:message-row-1-actions") as Box;
      const after = app.layout("text:Compiler review on Thursday") as Box;
      expect(Math.abs(right(actions) - spine)).toBeLessThan(1.01);
      expect(Math.abs((after?.x ?? 0) - (before?.x ?? 0))).toBeLessThan(0.5);
      expect(Math.abs((after?.width ?? 0) - (before?.width ?? 0))).toBeLessThan(0.5);

      // Ticking rows: the checkbox does not push the fixed row's lines apart.
      await app.keyboard.press("meta+a");
      await app.wait(400);
      expect(Math.abs((app.layout("id:message-row-0") as Box)!.height - 72 * k)).toBeLessThan(1.01);
      const detail = app.layout("text:Can we move the review to the afternoon?") as Box;
      const next = app.layout("id:message-row-2") as Box;
      expect(detail!.y + detail!.height).toBeLessThan(next!.y + 0.5);
    });
  }
}

test("the cursor lands on the list's bottom edge (base 16)", async () => {
  const app = await openFixture("dark", "16", "1");
  if (!(await drawn(app))) return;
  for (let i = 0; i < 30; i++) await app.keyboard.press("j");
  await app.wait(600);
  const list = app.layout("id:message-list") as Box;
  const row = app.layout("id:message-row-29") as Box;
  expect(!!row && !row.hidden).toBe(true);
  expect(Math.abs(row!.y + row!.height - (list!.y + list!.height))).toBeLessThan(1.01);
});

for (const size of ["14", "16"]) {
  test(`Chinese rows keep their lines and elide inside the row (base ${size})`, async () => {
    const k = Number(size) / 14;
    const app = await openFixture("dark", size, "cjk");
    if (!(await drawn(app))) return;
    await app.wait(400);
    for (let i = 0; i < 3; i++) {
      const row = app.layout(`id:message-row-${i}`) as Box;
      expect(Math.abs((row?.height ?? 0) - 72 * k)).toBeLessThan(1.01);
    }
    const row = app.layout("id:message-row-1") as Box;
    const meta = app.layout("id:message-row-1-meta") as Box;
    const subject = app.layout("text:关于二〇二七年度亚太区域渠道合作伙伴计划的调整方案与执行时间表的说明") as Box;
    const sender = app.layout("text:欧阳娜娜·国际业务发展与战略合作部高级经理") as Box;
    const snippet = app.layout("text:附件为修订后的方案全文，请各位在本周五下班前反馈意见，逾期视为同意。") as Box;
    // Long lines elide within the row; the sender stops before the time.
    expect(right(subject)).toBeLessThan(right(row) + 0.5);
    expect(right(snippet)).toBeLessThan(right(row) + 0.5);
    expect(right(sender)).toBeLessThan(meta!.x + 0.5);
    // Three lines inside the fixed row, one above the next (no vertical clipping).
    expect(sender!.y).toBeGreaterThan(row!.y - 0.5);
    expect(sender!.y + sender!.height).toBeLessThan(subject!.y + 0.5);
    expect(subject!.y + subject!.height).toBeLessThan(snippet!.y + 0.5);
    expect(snippet!.y + snippet!.height).toBeLessThan(row!.y + row!.height + 0.5);
    await app.screenshot(`.nsh/shots/list-cjk-${size}.png`);
  });
}

for (const size of ["14", "16"]) {
  test(`quick actions take the metadata's place, chip and time with it (hover, selected; base ${size})`, async () => {
    const app = await openFixture("light", size);
    if (!(await drawn(app))) return;
    const spine = right(app.layout("id:message-row-1-meta") as Box);
    // At rest: the metadata (thread chip and time) shows, the actions do not.
    expect(app.viewStyle("id:message-row-1-meta")!.effectiveOpacity).toBe(1);
    expect(app.viewStyle("id:message-row-1-actions")!.effectiveOpacity).toBe(0);

    await app.hover("text:Grace Hopper");
    await app.wait(400);
    expect(app.viewStyle("id:message-row-1-meta")!.effectiveOpacity).toBe(0);
    // The thread chip goes with it: it lies inside the faded metadata. (A
    // state style on an ancestor is not in a child's effectiveOpacity, so
    // the chip is checked by where it sits.)
    const meta = app.layout("id:message-row-1-meta") as Box;
    const chip = app.layout("id:message-row-1-thread") as Box;
    expect(chip!.x).toBeGreaterThan(meta!.x - 0.5);
    expect(right(chip)).toBeLessThan(right(meta) + 0.5);
    expect(app.viewStyle("id:message-row-1-actions")!.effectiveOpacity).toBe(1);
    expect(Math.abs(right(app.layout("id:message-row-1-actions") as Box) - spine)).toBeLessThan(1.01);
    await app.screenshot(`.nsh/shots/list-row-hover-${size}.png`);
    // The lane's actions in order, the last ending on the spine; the row is starred: its star is on.
    const names = ["archive", "trash", "star"].map((n) => app.layout(`id:message-row-1-${n}`) as Box);
    expect(names.every((b) => !!b && !b.hidden)).toBe(true);
    expect(names[0]!.x).toBeLessThan(names[1]!.x);
    expect(names[1]!.x).toBeLessThan(names[2]!.x);
    expect(Math.abs(right(names[2]) - spine)).toBeLessThan(1.01);
    expect(app.accessibility("id:message-row-1-star")?.selected).toBe(true);
    expect(app.accessibility("id:message-row-1-star")?.label).toBe("Unstar");

    // Selected (the keyboard cursor, two steps from none: Grace Hopper's row),
    // with the pointer gone from the rows.
    await app.hover("id:fixture-blank");
    await app.keyboard.press("j");
    await app.keyboard.press("j");
    await app.wait(400);
    expect(app.accessibility("id:message-row-1")?.selected).toBe(true);
    expect(app.viewStyle("id:message-row-1-meta")!.effectiveOpacity).toBe(0);
    expect(app.viewStyle("id:message-row-1-actions")!.effectiveOpacity).toBe(1);
    for (const other of [0, 2, 3]) {
      expect(app.viewStyle(`id:message-row-${other}-meta`)!.effectiveOpacity).toBe(1);
      expect(app.viewStyle(`id:message-row-${other}-actions`)!.effectiveOpacity).toBe(0);
    }
    expect(Math.abs(right(app.layout("id:message-row-1-actions") as Box) - spine)).toBeLessThan(1.01);
    await app.screenshot(`.nsh/shots/list-row-selected-${size}.png`);
  });
}

for (const size of ["14", "16"]) {
  test(`the unified list's mailbox label sizes to its name, up to a third of the row (base ${size})`, async () => {
    const k = Number(size) / 14;
    const app = await openFixture("dark", size, "unified", true);
    if (!(await drawn(app))) return;
    await app.wait(400);
    const rows = [0, 1, 2, 3, 4].map((i) => ({
      row: app.layout(`id:message-row-${i}`) as Box,
      meta: app.layout(`id:message-row-${i}-meta`) as Box,
      source: app.layout(`id:message-row-${i}-source`) as Box,
    }));
    const spine = right(rows[0].meta);
    const cap = Math.floor(rows[0].row!.width / 3);
    const short = rows.filter((r) => r.source && r.source.width < cap - 1);
    const long = rows.filter((r) => r.source && r.source.width >= cap - 1);
    expect(short.length).toBe(3);
    expect(long.length).toBe(2);
    for (const r of rows) expect(Math.abs(right(r.meta) - spine)).toBeLessThan(1.01);
    // The time itself on the spine, whatever the label's length.
    const times = ["4m", "9m", "52m"].map((t) => right(app.layout(`text:${t}`) as Box));
    for (const t of times) expect(Math.abs(t - times[0])).toBeLessThan(1.01);
    // On the time's line, not lifted off it.
    const mid = (b: Box) => b!.y + b!.height / 2;
    expect(Math.abs(mid(rows[0].source) - mid(app.layout("text:4m") as Box))).toBeLessThan(1.5 * k);
    // "jane.doe@example.com" (20 characters) sizes to itself: under the cap, so
    // never elided; at least 20 caption characters wide.
    for (const r of short) expect(r.source!.width).toBeGreaterThan(20 * 5 * k);
    // The long name stops at a third of the row; the sender keeps the rest.
    for (const r of long) expect(Math.abs(r.source!.width - cap)).toBeLessThan(1.01);
    const sender = app.layout("text:Lise Meitner") as Box;
    expect(sender!.width).toBeGreaterThan(40 * k);
    expect(right(sender)).toBeLessThan(long[0].meta!.x + 0.5);
    await app.screenshot(`.nsh/shots/list-unified-${size}.png`);
  });
}
