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
