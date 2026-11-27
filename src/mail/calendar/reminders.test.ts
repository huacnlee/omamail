// test_calendar_reminders.js of the Qt client, ported as written. Typed with the shapes in types.ts.
import { test } from "nsh/test";
import { assert, deepEqual } from "./testing";
import * as reminders from "./reminders";
import type { CalendarEvent, CalendarMoment, CalendarPerson, CalendarSource, SourceList } from "./types";

test("test_calendar_reminders.js", () => {
  const source = {id:"hidden",kind:"google",accountId:"me",enabled:false,remindersEnabled:true,reminderMinutes:-1,
    defaultReminders:[{method:"popup",minutes:10},{method:"email",minutes:20}]} as CalendarSource
  const event = {uid:"meeting",googleId:"instance",sourceId:"hidden",summary:"Planning",
    organizer:{email:"organizer@example.org"},start:{ms:2000000},end:{ms:5600000},reminders:{useDefault:true}} as CalendarEvent
  const candidates = reminders.candidates([event],{sources:[source]} as SourceList)
  assert.strictEqual(candidates.length,1,"hidden calendars can still remind, but email reminders do not become popups")
  assert.strictEqual(candidates[0].due,1400000)
  assert.strictEqual(reminders.candidates([{...event,reminders:{useDefault:false,overrides:[]}}],
    {sources:[{...source,reminderMinutes:5}]} as SourceList).length,0,"explicit no-reminders survives the local calendar override")
  assert.strictEqual(reminders.candidates([{...event,attendees:[{self:true,responseStatus:"declined"} as CalendarPerson]}],{sources:[source]} as SourceList).length,0)
  assert.strictEqual(reminders.candidates([event,{...event,sourceId:"shared"}],
    {sources:[source,{...source,id:"shared",accountId:"another"}]} as SourceList).length,1)
  assert.strictEqual(reminders.candidates([{...event,status:"CANCELLED"}],{sources:[source]} as SourceList).length,0)
  const instant = reminders.candidates([{...event,end:{ms:2000000} as CalendarMoment}],{sources:[source]} as SourceList)
  assert.strictEqual(instant.length,1,"an event that ends where it starts still reminds")
  assert.ok(instant[0].end > instant[0].start,"and the backend gets an end after its start")
  for (const kind of ["microsoft", "icloud", "caldav", "hey"]) {
    assert.strictEqual(reminders.candidates([event], {sources:[{...source,kind,reminderMinutes:10}]} as SourceList).length,0,
      "saved reminder settings must not enable deep integration for " + kind)
  }

});
