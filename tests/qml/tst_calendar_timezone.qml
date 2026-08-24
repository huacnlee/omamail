import QtQuick 2.15
import QtTest 1.3
import "../../message/Calendar.js" as Calendar

Item {
  TestCase {
    name: "CalendarTimezone"

    function test_named_zone_without_definition_is_stable_and_unresolved() {
      var invite = Calendar.invitationFrom([
        "BEGIN:VCALENDAR", "VERSION:2.0", "METHOD:REQUEST", "BEGIN:VEVENT",
        "UID:qml-zone", "SUMMARY:Call",
        "DTSTART;TZID=Europe/Stockholm:20260821T090000",
        "END:VEVENT", "END:VCALENDAR"
      ].join("\r\n"))

      verify(invite)
      compare(invite.start.ms, Date.UTC(2026, 7, 21, 9, 0, 0))
      compare(invite.start.resolved, false)
      verify(Calendar.formatWhen(invite).indexOf("09:00 (Europe/Stockholm)") > 0)
    }
  }
}
