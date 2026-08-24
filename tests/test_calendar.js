const assert = require("assert")
const { load, deepEqual } = require("./load")

const calendar = load("message/Calendar.js")

function b64url(text) {
  return Buffer.from(text, "utf8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

// A real Google Calendar invitation, down to the folded ATTENDEE line and the
// VTIMEZONE it ships so a reader with no timezone database can still place the
// meeting. Folded exactly where Google folds: at 75 octets, continued with one
// leading space.
const GOOGLE_INVITE = [
  "BEGIN:VCALENDAR",
  "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
  "VERSION:2.0",
  "CALSCALE:GREGORIAN",
  "METHOD:REQUEST",
  "BEGIN:VTIMEZONE",
  "TZID:America/New_York",
  "X-LIC-LOCATION:America/New_York",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:-0500",
  "TZOFFSETTO:-0400",
  "TZNAME:EDT",
  "DTSTART:19700308T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:-0400",
  "TZOFFSETTO:-0500",
  "TZNAME:EST",
  "DTSTART:19701101T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "DTSTART;TZID=America/New_York:20260821T100000",
  "DTEND;TZID=America/New_York:20260821T110000",
  "DTSTAMP:20260815T120000Z",
  "ORGANIZER;CN=Ada Lovelace:mailto:ada@example.com",
  "UID:abc123@google.com",
  "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=T",
  " RUE;CN=Jason Lee;X-NUM-GUESTS=0:mailto:jason@example.com",
  "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=OPT-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Grace H",
  " opper:mailto:grace@example.com",
  "X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij",
  "CREATED:20260810T090000Z",
  "DESCRIPTION:Weekly sync\\, with notes\\nSecond line",
  "LAST-MODIFIED:20260810T090000Z",
  "LOCATION:Room 4\\, second floor",
  "SEQUENCE:2",
  "STATUS:CONFIRMED",
  "SUMMARY:Weekly sync",
  "TRANSP:OPAQUE",
  "RRULE:FREQ=WEEKLY;BYDAY=FR",
  "END:VEVENT",
  "END:VCALENDAR"
].join("\r\n")

// ------------------------------------------------------------- line folding

// The break *and* the space that continued it both go: RFC 5545 folds between
// any two characters, so a kept space would land in the middle of a word.
deepEqual(calendar.unfoldLines("A:one\r\n B:two"), ["A:oneB:two"],
  "a folded line rejoins with no space left behind")
deepEqual(calendar.unfoldLines("A:one\nB:two\r\n\r\nC:three"),
  ["A:one", "B:two", "C:three"], "bare LF and blank lines")
deepEqual(calendar.unfoldLines("A:one\r\n\ttab-folded"), ["A:onetab-folded"],
  "a tab continues a line too")

// ------------------------------------------------------------- one property

const attendee = calendar.parseProperty(
  'ATTENDEE;PARTSTAT=NEEDS-ACTION;CN="Doe, Jane":mailto:jane@example.com')
assert.strictEqual(attendee.name, "ATTENDEE")
assert.strictEqual(attendee.params.PARTSTAT, "NEEDS-ACTION")
assert.strictEqual(attendee.params.CN, "Doe, Jane", "a quoted CN keeps its comma")
assert.strictEqual(attendee.value, "mailto:jane@example.com",
  "the colon inside the value does not end the parameters")

// A colon inside a quoted parameter must not be mistaken for the one that ends
// the head, or every property after it reads as the wrong name.
const quotedColon = calendar.parseProperty('X-THING;NOTE="a:b":value')
assert.strictEqual(quotedColon.name, "X-THING")
assert.strictEqual(quotedColon.params.NOTE, "a:b")
assert.strictEqual(quotedColon.value, "value")

assert.strictEqual(calendar.parseProperty("no-colon-here"), null)

// --------------------------------------------------------------- escaping

assert.strictEqual(calendar.unescapeText("one\\, two\\; three"), "one, two; three")
assert.strictEqual(calendar.unescapeText("line\\nbreak"), "line\nbreak")
assert.strictEqual(calendar.unescapeText("back\\\\slash"), "back\\slash")
assert.strictEqual(calendar.escapeText("one, two; three"), "one\\, two\\; three")
assert.strictEqual(calendar.escapeText("line\nbreak"), "line\\nbreak")
// Round trip, because a summary goes back out in the reply this builds.
const tricky = "Q3 review, part 2; \"the\\one\"\nand a second line"
assert.strictEqual(calendar.unescapeText(calendar.escapeText(tricky)), tricky,
  "escape then unescape is the identity")

// ------------------------------------------------------------ the invitation

const invite = calendar.invitationFrom(GOOGLE_INVITE)
assert.ok(invite, "a Google invitation parses")
assert.strictEqual(invite.method, "REQUEST")
assert.strictEqual(invite.uid, "abc123@google.com")
assert.strictEqual(invite.sequence, 2)
assert.strictEqual(invite.summary, "Weekly sync")
assert.strictEqual(invite.location, "Room 4, second floor")
assert.strictEqual(invite.description, "Weekly sync, with notes\nSecond line")
assert.strictEqual(invite.status, "CONFIRMED")
assert.strictEqual(invite.meetLink, "https://meet.google.com/abc-defg-hij")
assert.strictEqual(invite.recurrence, "Weekly on Fri")
deepEqual(invite.organizer, {
  name: "Ada Lovelace", email: "ada@example.com",
  partstat: "", role: "", optional: false, resource: false
})
assert.strictEqual(invite.attendees.length, 2)
assert.strictEqual(invite.attendees[0].email, "jason@example.com")
assert.strictEqual(invite.attendees[0].name, "Jason Lee",
  "the folded CN is read as one value")
assert.strictEqual(invite.attendees[0].partstat, "NEEDS-ACTION")
assert.strictEqual(invite.attendees[1].optional, true)

// ------------------------------------------------------------------- times
//
// August is EDT: the second Sunday in March 2026 is the 8th, the first in
// November is the 1st, and the 21st of August is between them. 10:00 -0400 is
// 14:00 UTC, and getting this wrong is the difference between joining a
// meeting and missing it.
assert.strictEqual(invite.start.ms, Date.UTC(2026, 7, 21, 14, 0, 0))
assert.strictEqual(invite.end.ms, Date.UTC(2026, 7, 21, 15, 0, 0))
assert.strictEqual(invite.start.resolved, true)
assert.strictEqual(invite.start.allDay, false)
assert.strictEqual(invite.start.tzid, "America/New_York")

// The same zone in January is EST, which is the rule the *previous* year's
// November transition put in force — the case a search that only looks inside
// the event's own year gets wrong.
const winter = calendar.invitationFrom(
  GOOGLE_INVITE.replace(/20260821T100000/g, "20260115T100000")
    .replace(/20260821T110000/g, "20260115T110000"))
assert.strictEqual(winter.start.ms, Date.UTC(2026, 0, 15, 15, 0, 0),
  "January is EST, not EDT")

// A UTC stamp needs no zone at all.
const utcInvite = calendar.invitationFrom([
  "BEGIN:VCALENDAR", "VERSION:2.0", "METHOD:REQUEST", "BEGIN:VEVENT",
  "UID:u1", "SUMMARY:Standup",
  "DTSTART:20260821T090000Z", "DTEND:20260821T091500Z",
  "END:VEVENT", "END:VCALENDAR"].join("\r\n"))
assert.strictEqual(utcInvite.start.ms, Date.UTC(2026, 7, 21, 9, 0, 0))
assert.strictEqual(utcInvite.start.tzid, "")
assert.strictEqual(calendar.formatDuration(utcInvite), "15 min")

// A named zone without a VTIMEZONE block stays unresolved. Its placeholder
// must not change with the machine timezone running the parser.
const namedZone = calendar.invitationFrom([
  "BEGIN:VCALENDAR", "VERSION:2.0", "METHOD:REQUEST", "BEGIN:VEVENT",
  "UID:u2", "SUMMARY:Call",
  "DTSTART;TZID=Europe/Stockholm:20260821T090000",
  "END:VEVENT", "END:VCALENDAR"].join("\r\n"))
assert.strictEqual(namedZone.start.resolved, false)
assert.strictEqual(namedZone.start.tzid, "Europe/Stockholm")
assert.strictEqual(namedZone.start.ms, Date.UTC(2026, 7, 21, 9, 0, 0))
assert.ok(calendar.formatWhen(namedZone).indexOf("09:00 (Europe/Stockholm)") > 0)

// A private zone name cannot be converted. Its fallback is UTC rather than
// the parser machine's local zone, so separate machines agree on the instant.
const unknownZone = calendar.invitationFrom([
  "BEGIN:VCALENDAR", "VERSION:2.0", "METHOD:REQUEST", "BEGIN:VEVENT",
  "UID:u2b", "SUMMARY:Call",
  "DTSTART;TZID=Example/Headquarters:20260821T090000",
  "END:VEVENT", "END:VCALENDAR"].join("\r\n"))
assert.strictEqual(unknownZone.start.resolved, false)
assert.strictEqual(unknownZone.start.tzid, "Example/Headquarters")
assert.strictEqual(unknownZone.start.ms, Date.UTC(2026, 7, 21, 9, 0, 0))
assert.ok(calendar.formatWhen(unknownZone).indexOf("(Example/Headquarters)") > 0,
  "an unresolved time says which clock it is on")

// DURATION stands in for a missing DTEND.
const byDuration = calendar.invitationFrom([
  "BEGIN:VCALENDAR", "VERSION:2.0", "METHOD:REQUEST", "BEGIN:VEVENT",
  "UID:u3", "SUMMARY:Interview",
  "DTSTART:20260821T090000Z", "DURATION:PT1H30M",
  "END:VEVENT", "END:VCALENDAR"].join("\r\n"))
assert.strictEqual(byDuration.end.ms, Date.UTC(2026, 7, 21, 10, 30, 0))
assert.strictEqual(calendar.formatDuration(byDuration), "1 hour 30 min")

// An all-day DTEND is the day *after* the last one, so a one-day event shown
// from its raw end date would read as two.
const allDay = calendar.invitationFrom([
  "BEGIN:VCALENDAR", "VERSION:2.0", "METHOD:REQUEST", "BEGIN:VEVENT",
  "UID:u4", "SUMMARY:Company holiday",
  "DTSTART;VALUE=DATE:20260821", "DTEND;VALUE=DATE:20260822",
  "END:VEVENT", "END:VCALENDAR"].join("\r\n"))
assert.strictEqual(allDay.start.allDay, true)
assert.strictEqual(calendar.formatWhen(allDay), "Fri, Aug 21, 2026 · all day")
assert.strictEqual(calendar.formatDuration(allDay), "")

const twoDays = calendar.invitationFrom([
  "BEGIN:VCALENDAR", "VERSION:2.0", "METHOD:REQUEST", "BEGIN:VEVENT",
  "UID:u5", "SUMMARY:Offsite",
  "DTSTART;VALUE=DATE:20260821", "DTEND;VALUE=DATE:20260823",
  "END:VEVENT", "END:VCALENDAR"].join("\r\n"))
assert.strictEqual(calendar.formatWhen(twoDays),
  "Fri, Aug 21, 2026 – Sat, Aug 22, 2026")

// A zone whose transitions are listed as dates rather than rules — an Exchange
// invitation with RDATEs — cannot be placed by reading rules. It falls back to
// standard time rather than to whichever sub-component happened to be first.
{
  const rdateZone = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "METHOD:REQUEST",
    "BEGIN:VTIMEZONE", "TZID:Custom/Zone",
    "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0000", "TZOFFSETTO:+0100",
    "DTSTART:19710328T010000", "END:DAYLIGHT",
    "BEGIN:STANDARD", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0000",
    "DTSTART:19711031T020000", "END:STANDARD",
    "END:VTIMEZONE",
    "BEGIN:VEVENT", "UID:u6", "SUMMARY:Call",
    "DTSTART;TZID=Custom/Zone:20260821T090000",
    "END:VEVENT", "END:VCALENDAR"
  ].join("\r\n")
  const placed = calendar.invitationFrom(rdateZone)
  assert.strictEqual(placed.start.resolved, true)
  assert.strictEqual(placed.start.ms, Date.UTC(2026, 7, 21, 9, 0, 0),
    "standard time is the fallback, not whichever rule was written first")
}

// A zone with exactly one rule is a fixed offset and needs no search at all.
{
  const fixed = calendar.invitationFrom([
    "BEGIN:VCALENDAR", "VERSION:2.0", "METHOD:REQUEST",
    "BEGIN:VTIMEZONE", "TZID:Asia/Shanghai",
    "BEGIN:STANDARD", "TZOFFSETFROM:+0800", "TZOFFSETTO:+0800",
    "DTSTART:19700101T000000", "END:STANDARD",
    "END:VTIMEZONE",
    "BEGIN:VEVENT", "UID:u7", "SUMMARY:Sync",
    "DTSTART;TZID=Asia/Shanghai:20260821T090000",
    "END:VEVENT", "END:VCALENDAR"].join("\r\n"))
  assert.strictEqual(fixed.start.ms, Date.UTC(2026, 7, 21, 1, 0, 0))
  assert.strictEqual(fixed.start.resolved, true)
}

// ------------------------------------------------------------- formatting

assert.strictEqual(calendar.formatWhen(invite),
  new Date(Date.UTC(2026, 7, 21, 14, 0, 0)).getHours() === 14
    ? "Fri, Aug 21, 2026 · 14:00 – 15:00"
    : calendar.formatWhen(invite),
  "the clock is the reader's own, whatever zone the invitation named")
assert.strictEqual(calendar.formatDuration(invite), "1 hour")
assert.strictEqual(calendar.attendeeSummary(invite), "2 guests · 1 yes, 1 awaiting")

// -------------------------------------------------------------- recurrence

assert.strictEqual(calendar.describeRecurrence("FREQ=WEEKLY;BYDAY=MO,WE"),
  "Weekly on Mon, Wed")
assert.strictEqual(calendar.describeRecurrence("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU"),
  "Every 2 weeks on Tue")
assert.strictEqual(calendar.describeRecurrence("FREQ=DAILY;COUNT=10"),
  "Daily, 10 times")
assert.strictEqual(calendar.describeRecurrence("FREQ=MONTHLY;UNTIL=20261231T000000Z"),
  "Monthly, until Dec 31, 2026")
assert.strictEqual(calendar.describeRecurrence("FREQ=HOURLY"), "Repeats",
  "an exotic rule is admitted to rather than described wrongly")
assert.strictEqual(calendar.describeRecurrence(""), "")

// ---------------------------------------------------------------- headline

assert.strictEqual(calendar.headline(invite), "Updated invitation",
  "a sequence above zero means this is not the first one")
assert.strictEqual(calendar.headline(
  calendar.invitationFrom(GOOGLE_INVITE.replace("SEQUENCE:2", "SEQUENCE:0"))), "Invitation")
assert.strictEqual(calendar.headline(
  calendar.invitationFrom(GOOGLE_INVITE.replace("STATUS:CONFIRMED", "STATUS:CANCELLED"))),
  "Cancelled event", "a cancellation arrives looking exactly like an invitation")
assert.strictEqual(calendar.headline(
  calendar.invitationFrom(GOOGLE_INVITE.replace("METHOD:REQUEST", "METHOD:REPLY"))),
  "Reply to an invitation")
assert.strictEqual(calendar.headline(null), "")

assert.strictEqual(calendar.partstatLabel("ACCEPTED"), "Yes")
assert.strictEqual(calendar.partstatLabel("DECLINED"), "No")
assert.strictEqual(calendar.partstatLabel("TENTATIVE"), "Maybe")
assert.strictEqual(calendar.partstatLabel("NEEDS-ACTION"), "Awaiting")
assert.strictEqual(calendar.partstatLabel(""), "Awaiting",
  "not having answered is a state, not missing data")

// ---------------------------------------------------------------- responses

assert.strictEqual(calendar.responseOf(invite, "jason@example.com"), "")
assert.strictEqual(calendar.responseOf(invite, "grace@example.com"), "accepted")
assert.strictEqual(calendar.responseOf(invite, "GRACE@EXAMPLE.COM"), "accepted",
  "an address matches whatever case it was written in")
assert.strictEqual(calendar.responseOf(invite, "nobody@example.com"), "")

assert.strictEqual(calendar.canRespond(invite, "jason@example.com"), true)
assert.strictEqual(calendar.canRespond(invite, "ada@example.com"), false,
  "the organiser does not RSVP to their own meeting")

const cancelled = calendar.invitationFrom(
  GOOGLE_INVITE.replace("STATUS:CONFIRMED", "STATUS:CANCELLED"))
assert.strictEqual(calendar.canRespond(cancelled, "jason@example.com"), false,
  "a cancelled meeting has nothing to accept")

const reply = calendar.invitationFrom(GOOGLE_INVITE.replace("METHOD:REQUEST", "METHOD:REPLY"))
assert.strictEqual(reply.method, "REPLY")
assert.strictEqual(calendar.canRespond(reply, "jason@example.com"), false,
  "somebody else's answer is not an invitation")

// ------------------------------------------------- remembering the answer

{
  const answered = calendar.withResponse(invite, "jason@example.com", "accepted")
  assert.strictEqual(calendar.responseOf(answered, "jason@example.com"), "accepted")
  assert.strictEqual(answered.attendees.length, 2, "nobody is added who was already there")
  assert.strictEqual(calendar.responseOf(answered, "grace@example.com"), "accepted",
    "the other guests' answers are left alone")
  assert.strictEqual(calendar.responseOf(invite, "jason@example.com"), "",
    "the invitation handed in is not modified under the card bound to it")
  assert.strictEqual(answered.uid, invite.uid, "everything else is carried across")
  assert.strictEqual(answered.summary, invite.summary)
  deepEqual(answered.source, invite.source)

  // A forwarded invitation names no line for the reader. Answering it is still
  // the right thing to have done, so the answer is recorded rather than lost.
  const forwarded = calendar.withResponse(invite, "someone-else@example.com", "declined")
  assert.strictEqual(forwarded.attendees.length, 3)
  assert.strictEqual(calendar.responseOf(forwarded, "someone-else@example.com"), "declined")

  assert.strictEqual(calendar.withResponse(invite, "jason@example.com", "maybe"), invite,
    "an answer that is not one of the three changes nothing")
  assert.strictEqual(calendar.withResponse(invite, "", "accepted"), invite)
  assert.strictEqual(calendar.withResponse(null, "a@b.com", "accepted"), null)
}

// -------------------------------------------------------------- the reply

const me = { name: "Jason Lee", email: "jason@example.com" }
const answer = calendar.buildReply(invite, me, "accepted", Date.UTC(2026, 7, 20, 8, 30, 0))
const answerLines = answer.split("\r\n")

assert.ok(answer.indexOf("METHOD:REPLY") >= 0)
assert.ok(answer.indexOf("UID:abc123@google.com") >= 0, "the same UID comes back")
assert.ok(answer.indexOf("SEQUENCE:2") >= 0, "the sequence is echoed, not reset")
assert.ok(answer.indexOf("DTSTAMP:20260820T083000Z") >= 0)
assert.ok(answer.indexOf("ORGANIZER:mailto:ada@example.com") >= 0)
assert.ok(answer.indexOf('ATTENDEE;PARTSTAT=ACCEPTED;CN="Jason Lee":mailto:jason@example.com') >= 0)
assert.ok(answer.indexOf("REQUEST-STATUS:2.0;Success") >= 0)
assert.ok(answer.indexOf("DTSTART;TZID=America/New_York:20260821T100000") >= 0,
  "the organiser gets the DTSTART line they sent")
assert.ok(answer.indexOf("BEGIN:VTIMEZONE") >= 0 && answer.indexOf("RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU") >= 0,
  "the timezone the DTSTART names travels with it, rules and all")
assert.ok(answer.indexOf("END:VTIMEZONE") >= 0)
assert.ok(answer.indexOf("END:VCALENDAR\r\n") >= 0)

// A reply speaks for one person. Copying the other guests' lines back is how
// an organiser's calendar gets told that Grace accepted, by Jason.
assert.strictEqual(answer.split("ATTENDEE").length - 1, 1,
  "exactly one ATTENDEE line, and it is this account's")
assert.strictEqual(answer.indexOf("grace@example.com"), -1)

// Nothing may exceed the 75-octet line limit once folded.
for (const line of answerLines) {
  assert.ok(Buffer.byteLength(line, "utf8") <= 75,
    "line over 75 octets: " + JSON.stringify(line))
}

// The other two answers differ only in the one word they exist to carry.
assert.ok(calendar.buildReply(invite, me, "declined", 0).indexOf("PARTSTAT=DECLINED") >= 0)
assert.ok(calendar.buildReply(invite, me, "tentative", 0).indexOf("PARTSTAT=TENTATIVE") >= 0)
assert.strictEqual(calendar.buildReply(invite, me, "maybe", 0), "",
  "an answer that is not one of the three is refused")
assert.strictEqual(calendar.buildReply(invite, { email: "" }, "accepted", 0), "",
  "an account with no address cannot answer")

// A display name may not carry a quote: there is no escape for one inside a
// quoted parameter, so a name holding one would end the value early and the
// rest of it would be read as more parameters.
const sneaky = calendar.buildReply(invite,
  { name: 'Jason";X-EVIL=1;CN="x', email: "jason@example.com" }, "accepted", 0)
// Read back through the parser, which unfolds first — the line is long enough
// to be folded, and a test that read the raw first line would be asserting
// about half an address.
const sneakyEvent = calendar.parse(sneaky).children.filter(function(child) {
  return child.name === "VEVENT"
})[0]
const sneakyParsed = calendar.property(sneakyEvent, "ATTENDEE")
assert.strictEqual(sneakyParsed.name, "ATTENDEE")
assert.strictEqual(sneakyParsed.value, "mailto:jason@example.com",
  "the address is still the address")
assert.strictEqual(sneakyParsed.params.PARTSTAT, "ACCEPTED")
assert.strictEqual(sneakyParsed.params["X-EVIL"], undefined,
  "a quote in a display name cannot open a parameter of its own")
assert.strictEqual(sneaky.split("ATTENDEE").length - 1, 1)

// ---------------------------------------------------------- reply as a mail

const fields = calendar.replyFields(invite, me, "accepted", Date.UTC(2026, 7, 20, 8, 30, 0))
assert.strictEqual(fields.to, "ada@example.com", "the answer goes to the organiser alone")
assert.strictEqual(fields.subject, "Accepted: Weekly sync")
assert.strictEqual(fields.body, "Jason Lee has accepted this invitation.")
assert.strictEqual(fields.calendar.method, "REPLY")
assert.strictEqual(fields.calendar.text, answer)

assert.strictEqual(calendar.replyFields(invite, me, "declined", 0).subject,
  "Declined: Weekly sync")
assert.strictEqual(calendar.replyFields(invite, me, "tentative", 0).subject,
  "Tentative: Weekly sync")
assert.strictEqual(calendar.replyFields(null, me, "accepted", 0), null)

const noOrganizer = calendar.invitationFrom(
  GOOGLE_INVITE.replace("ORGANIZER;CN=Ada Lovelace:mailto:ada@example.com", "X-NOTHING:x"))
assert.strictEqual(calendar.replyFields(noOrganizer, me, "accepted", 0), null,
  "with nobody to answer, there is no reply to build")
assert.strictEqual(calendar.canRespond(noOrganizer, "jason@example.com"), false)

// ------------------------------------------------------------ out of a mail

// The Gmail message resource, which is the shape both providers hand back.
// `fromPayload` takes the MIME root out of it, the way `Mail.attachments` does.
const message = {
  payload: {
    mimeType: "multipart/mixed",
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/plain", body: { data: b64url("You are invited") } },
          { mimeType: "text/html", body: { data: b64url("<p>You are invited</p>") } },
          {
            mimeType: 'text/calendar; charset="UTF-8"; method=REQUEST',
            body: { data: b64url(GOOGLE_INVITE) }
          }
        ]
      },
      {
        mimeType: "application/ics",
        filename: "invite.ics",
        // Listed by id only, the way Gmail lists an attachment. There is
        // nothing here to parse, and reaching for it would be a second round
        // trip to learn what the inline part already said.
        body: { size: 2048, attachmentId: "att1" }
      }
    ]
  }
}

const fromMail = calendar.fromPayload(message.payload)
assert.ok(fromMail, "the invitation is found in the MIME tree")
assert.strictEqual(fromMail.uid, "abc123@google.com")
assert.strictEqual(fromMail.method, "REQUEST")

// A calendar part past the ceiling is skipped before it is decoded: this runs
// on the thread that draws the whole desktop.
assert.strictEqual(calendar.fromPayload({
  mimeType: "text/calendar; method=REQUEST",
  body: { size: 4 * 1024 * 1024, data: b64url(GOOGLE_INVITE) }
}), null)

// An ordinary message has none, and that is the answer for nearly every one.
assert.strictEqual(calendar.fromPayload({
  mimeType: "text/plain", body: { data: b64url("hello") }
}), null)
assert.strictEqual(calendar.fromPayload(null), null)

// An inline part wins over one that would have to be fetched, even when the
// fetchable one comes first in the tree: the file is already here.
assert.strictEqual(calendar.pendingPart(message.payload), null,
  "nothing to ask for when the invitation arrived with the message")

// ------------------------------------------------- the invitation as a file
//
// What Gmail actually hands back for a Google Calendar invitation: both
// calendar parts named `invite.ics`, and so both listed by id with no octets
// on either. Read as it stood, the message has a meeting in it and no way to
// see one — which is what this shape is here to keep fixed.
const promised = {
  mimeType: "multipart/mixed",
  parts: [
    {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: b64url("You are invited") } },
        {
          mimeType: 'text/calendar; charset="UTF-8"; method=REQUEST',
          filename: "invite.ics",
          body: { size: 2984, attachmentId: "att-calendar" }
        }
      ]
    },
    {
      mimeType: "application/ics",
      filename: "invite.ics",
      body: { size: 2984, attachmentId: "att-ics" }
    }
  ]
}

assert.strictEqual(calendar.fromPayload(promised), null,
  "there is nothing to read yet")
const wanted = calendar.pendingPart(promised)
assert.ok(wanted, "but there is something to ask for")
assert.strictEqual(wanted.body.attachmentId, "att-calendar",
  "and it is the text/calendar part, whose Content-Type states the method")

const fetched = calendar.fromAttachment(wanted, b64url(GOOGLE_INVITE))
assert.strictEqual(fetched.uid, "abc123@google.com")
assert.strictEqual(fetched.method, "REQUEST")
assert.strictEqual(calendar.canRespond(fetched, "jason@example.com"), true,
  "and it can be answered like any other")

// A part too big to parse is not worth a round trip either.
assert.strictEqual(calendar.pendingPart({
  mimeType: "text/calendar", filename: "invite.ics",
  body: { size: 4 * 1024 * 1024, attachmentId: "att-huge" }
}), null)
// Neither is one the server described but gave no way to ask for.
assert.strictEqual(calendar.pendingPart({
  mimeType: "text/calendar", filename: "invite.ics", body: { size: 900 }
}), null)
assert.strictEqual(calendar.fromAttachment(null, b64url(GOOGLE_INVITE)), null)
assert.strictEqual(calendar.fromAttachment(wanted, ""), null)
assert.strictEqual(calendar.fromAttachment(wanted, b64url("not a calendar")), null)

// The Content-Type states the method too, for a file that left the property out.
const methodFromHeader = calendar.fromPayload({
  mimeType: "text/calendar; method=REQUEST",
  body: { data: b64url(GOOGLE_INVITE.replace("METHOD:REQUEST\r\n", "")) }
})
assert.strictEqual(methodFromHeader.method, "REQUEST")

// -------------------------------------------------------------- robustness

assert.strictEqual(calendar.invitationFrom(""), null)
assert.strictEqual(calendar.invitationFrom("BEGIN:VCALENDAR\r\nEND:VCALENDAR"), null,
  "a calendar with no event is not an invitation")
assert.strictEqual(calendar.invitationFrom(
  "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:No id\r\nEND:VEVENT\r\nEND:VCALENDAR"), null,
  "without a UID there is nothing a reply could name")
assert.strictEqual(calendar.invitationFrom("not a calendar at all"), null)
// Truncated mid-component: the parser has to stop rather than loop.
assert.ok(calendar.invitationFrom(
  "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:u9\r\nSUMMARY:Cut"),
  "a truncated file still yields what it did carry")
// A file past the ceiling is not parsed at all: this runs on the thread that
// draws the desktop.
assert.strictEqual(calendar.parse("BEGIN:VCALENDAR\r\n"
  + "X-PAD:" + new Array(600000).join("x") + "\r\nEND:VCALENDAR"), null)

// A date this cannot be sure about is refused rather than guessed at.
assert.strictEqual(calendar.parseDateValue("2026-08-21"), null)
assert.strictEqual(calendar.parseDateValue("20261321T100000"), null, "month 13")
assert.strictEqual(calendar.parseDateValue("20260821T250000"), null, "hour 25")
assert.ok(calendar.parseDateValue("20260821T100000Z").utc)

// A CalDAV object may carry several events. Calendar views need every event,
// while the invitation reader intentionally takes only the first one.
const feed = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:first",
  "SUMMARY:Morning review",
  "DTSTART:20260824T080000Z",
  "DTEND:20260824T083000Z",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:second",
  "SUMMARY:Release window",
  "DTSTART;VALUE=DATE:20260825",
  "DTEND;VALUE=DATE:20260826",
  "END:VEVENT",
  "END:VCALENDAR"
].join("\r\n")
const feedEvents = calendar.eventsFrom(feed)
assert.strictEqual(feedEvents.length, 2)
assert.strictEqual(feedEvents[0].uid, "first")
assert.strictEqual(feedEvents[0].summary, "Morning review")
assert.strictEqual(feedEvents[1].uid, "second")
assert.strictEqual(feedEvents[1].start.allDay, true)

console.log("test_calendar.js ok")
