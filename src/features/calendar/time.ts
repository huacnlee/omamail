// The user's clock and week, from the system (`localeSettings()`), in the
// forms the ported rules take. Reactive where read in a binding.
import { localeSettings } from "nsh";
import type { HourCycle } from "../../mail/calendar/format";

/** "h12" or "h23", as the ported labels take them. */
export function localeHourCycle(): HourCycle {
  const cycle = localeSettings().hourCycle;
  return cycle === "h11" || cycle === "h12" ? "h12" : "h23";
}

/** The day a week starts on, 0 for Sunday (Date.getDay's count). */
export function firstWeekday(): number {
  return localeSettings().firstDayOfWeek % 7;
}

/** The time zone the views show, as the system names it. */
export function localTimeZone(): string {
  return localeSettings().timeZone || "UTC";
}
