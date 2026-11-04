const assert = require("assert")
const { load } = require("./load")
const invitations = load("calendar/Invitations.js")
const source = {kind:"google",accountId:"calendar@example.org",id:"google:work",name:"Work"}
const invite = {uid:"test",organizer:{email:"host@example.org"},sequence:2,
  start:{ms:Date.UTC(2026,9,27,10),resolved:true},end:{ms:Date.UTC(2026,9,27,11),resolved:true},
  source:{dtstart:"DTSTART:20261027T100000Z"},recurrenceRule:"FREQ=WEEKLY;COUNT=4",
  excludedMs:[Date.UTC(2026,10,3,10)],summary:"Weekly <planning>",meetLink:"https://meet.example.org/join"}
const p = invitations.params(source,"imap:me@example.org",invite,"accepted")
assert.equal(p.event.start.timeZone,"UTC")
assert.equal(p.event.recurrence[1],"EXDATE:20261103T100000Z")
assert.ok(p.event.description.includes(invite.meetLink))
assert.equal(p.event.attendees,undefined)
assert.equal(invitations.params(source,"mailbox",{...invite,start:{...invite.start,resolved:false}},"accepted"),null)
const calendar = load("message/Calendar.js")
const windowsInvite = calendar.invitationFrom([
  "BEGIN:VCALENDAR", "VERSION:2.0", "METHOD:REQUEST",
  "BEGIN:VTIMEZONE", "TZID:W. Europe Standard Time",
  "BEGIN:STANDARD", "DTSTART:19701025T030000", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD",
  "BEGIN:DAYLIGHT", "DTSTART:19700329T020000", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT", "END:VTIMEZONE",
  "BEGIN:VEVENT", "UID:synthetic-windows-zone", "ORGANIZER:mailto:host@example.org",
  "DTSTART;TZID=W. Europe Standard Time:20261030T150000",
  "DTEND;TZID=W. Europe Standard Time:20261030T153000", "END:VEVENT", "END:VCALENDAR"
].join("\r\n"))
const windowsExport = invitations.params(source,"mailbox",windowsInvite,"accepted").event
assert.equal(windowsExport.start.dateTime,"2026-10-30T14:00:00.000Z")
assert.equal(windowsExport.end.dateTime,"2026-10-30T14:30:00.000Z")
assert.equal(windowsExport.start.timeZone,undefined,"one-off events must not export a Windows-only TZID")
assert.equal(windowsExport.end.timeZone,undefined)
const series = {...invite,start:{...invite.start,tzid:"Europe/Berlin"},end:{...invite.end,tzid:"Europe/Berlin"}}
assert.equal(invitations.params(source,"mailbox",series,"accepted").event.start.timeZone,"Europe/Berlin",
  "recurring series retain their zone so future occurrences follow daylight saving")
const occurrence = {...series,recurrenceIdMs:series.start.ms}
assert.equal(invitations.params(source,"mailbox",occurrence,"accepted").event.start.timeZone,undefined,
  "a single resolved occurrence also uses its exact instant")
const day = {...invite,recurrenceRule:"",start:{ms:Date.UTC(2026,9,26,22),allDay:true},end:{ms:Date.UTC(2026,9,27,22),allDay:true},
  source:{dtstart:"DTSTART;VALUE=DATE:20261027",dtend:"DTEND;VALUE=DATE:20261028"}}
assert.equal(invitations.params(source,"mailbox",day,"tentative").event.start.date,"2026-10-27")
assert.equal(invitations.params(source,"mailbox",day,"tentative").event.end.date,"2026-10-28")
const cancel = invitations.params(source,"mailbox",{uid:"test",organizer:invite.organizer},"cancelled")
assert.equal(cancel.event,undefined)
assert.equal(invitations.destination({},"mailbox"),null)
assert.equal(invitations.destination({invitationCalendars:{mailbox:{...source,readOnly:true}}},"mailbox"),null)
console.log("calendar invitations ok")
const sources = load("calendar/Sources.js")
const calendars = {version:1,sources:[source,{kind:"google",id:"google:other",accountId:"other@example.org"}]}
assert.equal(sources.forAccount(calendars,"imap:me@example.org",source.id).sources.length,1)
assert.equal(sources.forAccount(calendars,"imap:me@example.org").sources.length,0)
for (const [status, reason, advice] of [[400,"badRequest","invalid"], [401,"authError","Sign in"],
  [403,"forbidden","refused access"], [403,"rateLimitExceeded","limiting requests"],
  [404,"notFound","no longer available"], [409,"duplicate","conflicts"], [412,"conditionNotMet","conflicts"],
  [429,"","limiting requests"], [503,"backendError","temporarily unavailable"],
  [400,"participantIsNeitherOrganizerNorAttendee","missing the destination calendar owner"]]) {
  const error = {message:"calendar_request_failed",data:{provider:"google",operation:"import",stage:"request",httpStatus:status,reason,message:"SECRET"}}
  const text = invitations.failure(error,10)
  assert.ok(text.includes(advice), text)
  assert.ok(text.includes("HTTP " + status), text)
  assert.ok(text.includes("will not resend"), text)
  assert.ok(!text.includes("SECRET"), text)
  assert.ok(!invitations.failure(error,9).includes("HTTP"))
}
for (const value of ["badRequest\n", "badRequest\r", "badRequest\r\n", "badRequest\0", 'SECRET "\\日本語', {}, true]) {
  const text = invitations.failure({message:value,data:{provider:value,reason:value,operation:value,stage:value,httpStatus:value}},10)
  assert.ok(!text.includes("SECRET") && !text.includes("badRequest"))
}
const zone = invitations.failure({message:"calendar_request_failed",data:{provider:"google",operation:"import",stage:"request",httpStatus:400,reason:"badRequest",field:"start.timeZone"}},10)
assert.ok(zone.includes("rejected the invitation's time zone") && zone.includes("start.timeZone"))
