// The calendar's settings as stored and as the Qt plugin hands them over.
import { expect, test } from "nsh/test";
import { importedSettings, parseSettings } from "./settings";

test("stored settings are checked, anything malformed read as the default", () => {
  expect(parseSettings(null).calendarSnoozeMinutes).toBe(5);
  expect(parseSettings("not json").calendarRemindersEnabled).toBe(true);
  const value = parseSettings(JSON.stringify({ calendarSnoozeMinutes: 99999, calendarHourHeight: -4, unifiedCalendarView: "yes" }));
  expect(value.calendarSnoozeMinutes).toBe(1440);
  expect(value.calendarHourHeight).toBe(0);
  expect(value.unifiedCalendarView).toBe(false);
});

test("the plugin's export gives only the calendar's own keys, through the same rules", () => {
  expect(importedSettings(null)).toBe(null);
  expect(importedSettings({ undoSendSeconds: 10 })).toBe(null);
  const value = importedSettings({ unifiedCalendarView: true, calendarSnoozeMinutes: "15", aiAgent: "x",
    invitationCalendars: ["not", "an", "object"] })!;
  expect(value.unifiedCalendarView).toBe(true);
  expect(value.calendarSnoozeMinutes).toBe(15);
  expect(value.invitationCalendars).toEqual({});
  expect("aiAgent" in value).toBe(false);
});
