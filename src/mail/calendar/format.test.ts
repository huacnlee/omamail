// test_calendar_time.js of the Qt client: the labels keep their shapes, with
// the hour cycle in place of Qt's locale time format.
import { test } from "nsh/test";
import { assert } from "./testing";
import * as calendar from "./calendar";
import { formatDate } from "./format";

function at(hour: number, minute = 0, day = 1): number {
  return new Date(2026, 9, day, hour, minute).getTime();
}

test("time labels follow the hour cycle", () => {
  assert.strictEqual(calendar.timeLabel(at(15), "h12"), "3:00 PM", "an afternoon needs AM/PM on a 12-hour clock");
  assert.strictEqual(calendar.timeLabel(at(15), "h23"), "15:00");
  assert.strictEqual(calendar.timeLabel(at(0), "h12"), "12:00 AM");
  assert.strictEqual(calendar.timeLabel(at(12), "h12"), "12:00 PM");
  assert.strictEqual(calendar.timeLabel(at(0), "h23"), "00:00");
  assert.strictEqual(calendar.timeLabel(at(12), "h23"), "12:00");
  assert.strictEqual(calendar.timeLabel(at(3, 5), "h12"), "3:05 AM");
  assert.strictEqual(calendar.timeLabel(NaN, "h12"), "");
  assert.strictEqual(calendar.timeRangeLabel(at(23, 30), at(0, 15, 2), "h12"), "11:30 PM–12:15 AM");
  assert.strictEqual(calendar.timeRangeLabel(at(11, 30), at(12, 15), "h12"), "11:30 AM–12:15 PM");
});

test("date labels keep the Qt patterns", () => {
  for (const [cycle, start, end] of [["h12", "3:00 PM", "4:30 PM"], ["h23", "15:00", "16:30"]]) {
    assert.strictEqual(calendar.timeRangeLabel(at(15), at(16, 30), cycle), start + "–" + end);
    assert.strictEqual(calendar.timeRangeLabel(at(15), at(16, 30), cycle, " – "), start + " – " + end);
    assert.strictEqual(calendar.dateTimeLabel(at(15), "d MMM", cycle), "1 Oct " + start);
    assert.strictEqual(calendar.dateTimeLabel(at(15), "d MMM", cycle, " · "), "1 Oct · " + start);
    assert.strictEqual(calendar.dateTimeLabel(at(15), "ddd, MMM d", cycle, " · "), "Thu, Oct 1 · " + start);
    assert.strictEqual(calendar.dateTimeLabel(at(15), "ddd", cycle), "Thu " + start);
    assert.strictEqual(calendar.dateTimeLabel(at(15), "ddd d MMM", cycle, ", ") + " – "
      + calendar.dateTimeLabel(at(16, 30, 2), "ddd d MMM", cycle, ", "), "Thu 1 Oct, " + start + " – Fri 2 Oct, " + end);
  }
  assert.strictEqual(formatDate(new Date(2026, 9, 1), "dddd, d MMMM yyyy"), "Thursday, 1 October 2026");
});
