import QtQuick
import QtTest
import "../../message/Message.js" as Mail
import "../../message/Calendar.js" as Invite
import "../../calendar/Calendar.js" as Calendar
import "../../agent/Agent.js" as Agent

TestCase {
  name: "LocaleClock"
  // Literal expectations exercise Qt, including separators and translated day periods.
  readonly property var hours: [0, 12, 15, 23]
  readonly property string periodSpace: Qt.locale().timeFormat(Locale.ShortFormat).indexOf("\u202f") >= 0 ? "\u202f" : " "
  readonly property var labels: Qt.locale().name === "en_US"
    ? ["12:05" + periodSpace + "AM", "12:05" + periodSpace + "PM", "3:05" + periodSpace + "PM", "11:05" + periodSpace + "PM"]
    : Qt.locale().name === "fi_FI" ? ["0.05", "12.05", "15.05", "23.05"]
    : Qt.locale().name === "zh_TW" ? ["上午12:05", "下午12:05", "下午3:05", "下午11:05"]
    : ["00:05", "12:05", "15:05", "23:05"]

  function initTestCase() {
    if (["en_US", "en_GB", "fi_FI", "zh_CN", "zh_TW"].indexOf(Qt.locale().name) < 0)
      skip("Literal locale expectations run in tests/test_locale_clock.py")
  }
  function test_invitation_clocks_follow_locale() {
    for (var i = 0; i < hours.length; i++) {
      var local = new Date(2026, 9, 22, hours[i], 5)
      compare(Invite.clockOf(local.getTime(), false), labels[i])
      // Unresolved zones must keep UTC wall components even with a non-UTC host TZ.
      compare(Invite.clockOf(Date.UTC(2026, 9, 22, hours[i], 5), true), labels[i])
    }
  }
  function test_exact_midnight_and_noon() {
    var expected = Qt.locale().name === "en_US" ? ["12:00" + periodSpace + "AM", "12:00" + periodSpace + "PM"]
      : Qt.locale().name === "fi_FI" ? ["0.00", "12.00"]
      : Qt.locale().name === "zh_TW" ? ["上午12:00", "下午12:00"] : ["00:00", "12:00"]
    compare(Invite.clockOf(new Date(2026, 9, 22, 0, 0).getTime(), false), expected[0])
    compare(Invite.clockOf(new Date(2026, 9, 22, 12, 0).getTime(), false), expected[1])
  }
  function test_mail_presentation_preserves_sources() {
    var summary = {from:{display:"Sender"},time:"15:05", fullTime:"Oct 22, 2026 15:05", date:new Date(2026, 9, 22, 15, 5)}
    var before = JSON.stringify(summary)
    var quote = Mail.quoteBody(summary, "Body says 15:05, unchanged")
    compare(Mail.displayTimeLabel(summary.time, summary.date), labels[2])
    compare(Mail.displayTimeLabel(summary.fullTime, summary.date), "Oct 22, 2026 " + labels[2])
    compare(Mail.displayTimeLabel("15:05"), labels[2])
    compare(Mail.displayTimeLabel("Oct 22, 2026 15:05"), "Oct 22, 2026 " + labels[2])
    // The timestamp wins over a stale cached clock, without changing the date prefix.
    compare(Mail.displayTimeLabel("16:02", summary.date.toISOString()), labels[2])
    var unknown = ["now", "5m", "Wed", "Oct 22", "yesterday at 15:05", "<b>15:05</b>",
      "24:00", "16:60", "16:02:30", "16:02\n", "2026-10-22T15:05", "Oct 99, 2026 15:05"]
    for (var i = 0; i < unknown.length; i++)
      compare(Mail.displayTimeLabel(unknown[i], summary.date), unknown[i])
    compare(JSON.stringify(summary), before)
    compare(Mail.quoteBody(summary, "Body says 15:05, unchanged"), quote)
  }
  function test_entry_roundtrip_and_legacy_input() {
    for (var i = 0; i < hours.length; i++) {
      var at = new Date(2026, 9, 22, hours[i], 5)
      var range = Calendar.editorDateRange("2026-10-22", labels[i], "2026-10-23", labels[i], false)
      verify(range.ok, range.error)
      compare(range.startMs, at.getTime())
      compare(range.endMs, new Date(2026, 9, 23, hours[i], 5).getTime())
    }
    if (Qt.locale().name === "en_US") {
      var boundaries = Calendar.editorDateRange("2026-10-22", "12:00 am", "2026-10-22", "12:00 PM", false)
      verify(boundaries.ok)
      compare(boundaries.startMs, new Date(2026, 9, 22, 0, 0).getTime())
      compare(boundaries.endMs, new Date(2026, 9, 22, 12, 0).getTime())
    }
    var legacy = Calendar.editorDateRange("2026-10-22", "00:05", "2026-10-22", "15:05", false)
    verify(legacy.ok)
    compare(legacy.startMs, new Date(2026, 9, 22, 0, 5).getTime())
    compare(legacy.endMs, new Date(2026, 9, 22, 15, 5).getTime())
    var invalid = ["24:00", "12:60", "0:30\u202fAM", "13:00\u202fPM", "12:60\u202fPM", "12:00 XX", "15:05 junk", "", "12:05:30"]
    for (var j = 0; j < invalid.length; j++)
      verify(!Calendar.editorDateRange("2026-10-22", invalid[j], "2026-10-23", labels[2], false).ok, invalid[j])
    verify(!Calendar.editorDateRange("2026-02-30", "12:00", "2026-03-02", "12:00", false).ok)
    verify(!Calendar.editorDateRange("2026-10-22", "15:00", "2026-10-22", "14:00", false).ok)
    var allDay = Calendar.editorDateRange("2026-10-22", "ignored", "2026-10-23", "ignored", true)
    verify(allDay.ok)
    compare(allDay.startMs, new Date(2026, 9, 22).getTime())
    compare(allDay.endMs, new Date(2026, 9, 24).getTime())
  }
  function test_agent_ranges_and_all_day() {
    var start = new Date(2026, 9, 22, 23, 5).getTime()
    var end = new Date(2026, 9, 23, 0, 5).getTime()
    compare(Agent.suggestionWhen({startMs:start,endMs:end}, start),
      "Thu 22 Oct, " + labels[3] + " – Fri 23 Oct, " + labels[0])
    compare(Agent.suggestionWhen({startMs:start,endMs:end,allDay:true}, start),
      "Thu 22 Oct – Fri 23 Oct (all day)")
  }
  function test_invitation_ranges_and_all_day() {
    var start = Date.UTC(2026, 9, 22, 23, 5)
    var end = Date.UTC(2026, 9, 23, 0, 5)
    var invite = {start:{ms:start,resolved:false,tzid:"Private/Zone"},end:{ms:end}}
    var before = JSON.stringify(invite)
    compare(Invite.formatWhen(invite), "Thu, Oct 22, 2026 · " + labels[3]
      + " – Fri, Oct 23, 2026 " + labels[0] + " (Private/Zone)")
    compare(JSON.stringify(invite), before)
    var resolved = {start:{ms:new Date(2026,9,22,12,5).getTime(), resolved:true, tzid:"UTC"},
      end:{ms:new Date(2026,9,22,15,5).getTime()}}
    compare(Invite.formatWhen(resolved), "Thu, Oct 22, 2026 · " + labels[1] + " – " + labels[2])
    invite.start = {ms:new Date(2026,9,22).getTime(), allDay:true,resolved:true,tzid:""}
    invite.end = {ms:new Date(2026,9,23).getTime(), allDay:true}
    compare(Invite.formatWhen(invite), "Thu, Oct 22, 2026 · all day")
  }
  function test_existing_calendar_locale_behavior() {
    var at = new Date(2026, 9, 22, 15, 5).getTime()
    compare(Calendar.timeLabel(at, Qt.locale().timeFormat(Locale.ShortFormat)), labels[2])
  }
}
