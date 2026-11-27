// Chinese input in the calendar: the event editor's fields under an input
// method (pinyin marked at the caret, then committed), Enter and Escape while
// a composition is open, the view's one-letter keys, guests, and CJK titles
// in the week and month. Synthetic data on a stand-in backend only.
import { expect, test } from "nsh/test";
import { EVENT, openCalendar, today, writes } from "./testing/stub";

async function openEditor(events?: unknown[]) {
  const opened = await openCalendar(events);
  await opened.app.press("id:calendar-new-event");
  await opened.app.waitFor("id:event-composer");
  return opened;
}

const created = (log: Parameters<typeof writes>[0]) => writes(log).filter((r) => r.params.operation === "create");

test("pinyin shows marked without changing the title, and the committed characters are saved", async () => {
  const { app, log } = await openEditor();
  await app.compose("id:event-title-field", "zhong");
  expect(app.value("id:event-title-field")).toBe("");
  await app.compose("id:event-title-field", "");
  await app.type("id:event-title-field", "中文 Hello 世界 😀");
  expect(app.value("id:event-title-field")).toBe("中文 Hello 世界 😀");
  await app.type("id:event-location-field", "会议室 4");
  await app.press("id:event-save-button");
  await app.waitUntil(() => created(log).length === 1);
  const body = JSON.parse(String(created(log)[0].params.body));
  expect(body.summary).toBe("中文 Hello 世界 😀");
  expect(body.location).toBe("会议室 4");
});

// The input method owns Enter and Escape while it composes: the key router
// binds nothing then (ui's imeComposing()), and the field holds onSubmit.
test("Enter picks the candidate while composing; only after it ends does Enter save", async () => {
  const { app, log } = await openEditor();
  await app.type("id:event-title-field", "周会");
  await app.compose("id:event-title-field", "zhou");
  await app.keyboard.press("enter");
  await app.wait(50);
  expect(created(log)).toEqual([]);
  expect(app.shows("id:event-composer")).toBe(true);
  await app.compose("id:event-title-field", "");
  await app.keyboard.press("enter");
  await app.waitUntil(() => created(log).length === 1);
});

test("Escape while composing cancels the composition only", async () => {
  const { app, log } = await openEditor();
  await app.type("id:event-title-field", "周会");
  await app.compose("id:event-title-field", "hui");
  await app.keyboard.press("escape");
  await app.wait(50);
  expect(app.shows("id:event-composer")).toBe(true);
  expect(app.value("id:event-title-field")).toBe("周会");
  await app.compose("id:event-title-field", "");
  expect(writes(log)).toEqual([]);
});

test("the view's one-letter keys stay letters in the editor's fields and in pinyin", async () => {
  const { app } = await openEditor();
  // d, w, m, a, t and c switch the view or open the editor outside a field.
  await app.compose("id:event-title-field", "dwmatc");
  await app.compose("id:event-title-field", "");
  await app.type("id:event-title-field", "dwmatc");
  expect(app.value("id:event-title-field")).toBe("dwmatc");
  await app.type("id:event-location-field", "jkhl");
  expect(app.value("id:event-location-field")).toBe("jkhl");
  await app.press("text:Cancel");
  await app.waitFor("id:event-composer", { state: "gone" });
  expect(app.shows("id:calendar-week")).toBe(true);
});

test("guests: separators inside a composition do nothing, a CJK name finds its contact", async () => {
  const { app } = await openEditor();
  await app.compose("id:event-guests-field", "li, an; ");
  expect(app.value("id:event-guests-field")).toBe("");
  expect(app.shows("id:event-guest-suggestions")).toBe(false);
  await app.compose("id:event-guests-field", "");
  await app.type("id:event-guests-field", "李");
  await app.waitFor("text:李安");
  expect(app.shows("text:Ann Lee")).toBe(false);
  await app.press("text:李安");
  await app.waitUntil(() => (app.value("id:event-guests-field") ?? "").includes("lian@example.com"));
  expect(app.value("id:event-guests-field")).not.toContain("李安");
});

test("a long CJK title elides on one line in the week and month", async () => {
  const long = { ...EVENT, id: "cjk", summary: "季度产品规划评审会议与跨部门协调讨论（第二轮）",
    start: { dateTime: today(14).toISOString() }, end: { dateTime: today(14, 30).toISOString() } };
  const { app } = await openCalendar([long]);
  await app.waitFor("text:" + long.summary);
  // The 30-minute card keeps the title to one line, inside its day column
  // (a seventh of the window beside the hour rail).
  const text = app.layout("text:" + long.summary)!;
  expect(text.height).toBeLessThan(2 * 16);
  expect(text.width).toBeLessThan(1100 / 7);
  await app.press("text:Month");
  await app.waitFor("id:calendar-month");
  const chip = app.layout("text:" + long.summary)!;
  expect(chip.height).toBeLessThan(2 * 16);
  expect(chip.width).toBeLessThan(1100 / 7);
});
