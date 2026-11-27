// The calendar page on the synthetic fixture in the dark palette (tokyo-night): for
// screenshots and the keyboard checks on a real platform, where native
// stand-ins are unavailable. It reaches nothing on this machine.
import { useCalendarFixture } from "./fixture";
import { mountCalendar } from "./mountCalendar";

useCalendarFixture();
mountCalendar("tokyo-night");
