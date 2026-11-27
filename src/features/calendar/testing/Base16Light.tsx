// The calendar calendar on the synthetic fixture at Omarchy base size 16
// (flexoki-light): for checking that rows, gutters and cards scale without clipping.
// It reaches nothing on this machine.
import { setOmarchyFont } from "../../../ui";
import { FIXTURE_CALENDARS, useCalendarFixture } from "./fixture";
import { mountCalendar } from "./mountCalendar";

useCalendarFixture(FIXTURE_CALENDARS);
setOmarchyFont({ family: null, baseSize: 16 });
mountCalendar("flexoki-light", "calendar");
