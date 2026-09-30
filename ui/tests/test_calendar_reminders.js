const assert = require("assert")
const { load } = require("./load")
const reminders = load("calendar/Reminders.js")
const source = {id:"hidden",kind:"google",accountId:"me",enabled:false,remindersEnabled:true,reminderMinutes:-1,
  defaultReminders:[{method:"popup",minutes:10},{method:"email",minutes:20}]}
const event = {uid:"meeting",googleId:"instance",sourceId:"hidden",summary:"Planning",
  organizer:{email:"organizer@example.org"},start:{ms:2000000},end:{ms:5600000},reminders:{useDefault:true}}
const candidates = reminders.candidates([event],{sources:[source]})
assert.strictEqual(candidates.length,1,"hidden calendars can still remind, but email reminders do not become popups")
assert.strictEqual(candidates[0].due,1400000)
assert.strictEqual(reminders.candidates([{...event,reminders:{useDefault:false,overrides:[]}}],
  {sources:[{...source,reminderMinutes:5}]}).length,0,"explicit no-reminders survives the local calendar override")
assert.strictEqual(reminders.candidates([{...event,attendees:[{self:true,responseStatus:"declined"}]}],{sources:[source]}).length,0)
assert.strictEqual(reminders.candidates([event,{...event,sourceId:"shared"}],
  {sources:[source,{...source,id:"shared",accountId:"another"}]}).length,1)
assert.strictEqual(reminders.candidates([{...event,status:"CANCELLED"}],{sources:[source]}).length,0)
console.log("calendar reminder eligibility tests passed")
for (const kind of ["microsoft", "icloud", "caldav", "hey"]) {
  assert.strictEqual(reminders.candidates([event], {sources:[{...source,kind,reminderMinutes:10}]}).length,0,
    "saved reminder settings must not enable deep integration for " + kind)
}
