// Settings → Calendars on the synthetic fixture, in the light palette: for
// screenshots on a real platform. It reaches nothing on this machine.
import { FIXTURE_CALENDARS, useCalendarFixture } from "./fixture";
import { mountCalendar } from "./mountCalendar";

useCalendarFixture(FIXTURE_CALENDARS);
mountCalendar("flexoki-light", "settings");
