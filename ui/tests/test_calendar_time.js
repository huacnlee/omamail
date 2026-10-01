const assert = require("assert")
const vm = require("vm")
const { load } = require("./load")

const calendar = load("calendar/Calendar.js")
const locale = { name: "test-system-locale" }
const formats = {
  "h:mm AP": new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hourCycle: "h12" }),
  "HH:mm": new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
  "HH.mm": new Intl.DateTimeFormat("fi-FI", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
}

// Supply only Qt's formatting boundary. The module must pass the locale's
// format through intact; Intl supplies real locale clocks without a Qt host.
calendar.Qt = {
  locale() { return locale },
  formatTime(date, suppliedLocale, format) {
    assert.strictEqual(suppliedLocale, locale, "localize AM/PM using the system locale")
    assert.ok(formats[format], "use the supplied locale format")
    return formats[format].format(date)
  },
  formatDate(date, format) {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()]
    const labels = {
      "d MMM": date.getDate() + " " + months[date.getMonth()],
      "ddd": weekday,
      "ddd, MMM d": weekday + ", " + months[date.getMonth()] + " " + date.getDate(),
      "ddd d MMM": weekday + " " + date.getDate() + " " + months[date.getMonth()]
    }
    assert.ok(labels[format], "use the date label's existing shape")
    return labels[format]
  }
}
// QML extends Date with a (locale, format) overload absent from Node.
vm.runInContext("Date.prototype.toLocaleTimeString = function(locale, format) { return Qt.formatTime(this, locale, format) }", calendar)
function at(hour, minute = 0, day = 1) {
  return new Date(2026, 9, day, hour, minute).getTime()
}

assert.strictEqual(calendar.timeLabel(at(15), "h:mm AP"), "3:00 PM", "an afternoon needs AM/PM in a 12-hour locale")
assert.strictEqual(calendar.timeLabel(at(15), "HH:mm"), "15:00")
assert.strictEqual(calendar.timeLabel(at(0), "h:mm AP"), "12:00 AM")
assert.strictEqual(calendar.timeLabel(at(12), "h:mm AP"), "12:00 PM")
assert.strictEqual(calendar.timeLabel(at(0), "HH:mm"), "00:00")
assert.strictEqual(calendar.timeLabel(at(12), "HH:mm"), "12:00")
assert.strictEqual(calendar.timeLabel(at(3, 5), "h:mm AP"), "3:05 AM")
assert.strictEqual(calendar.timeLabel(at(15, 5), "HH.mm"), "15.05", "keep the locale's separator")
assert.strictEqual(calendar.timeLabel(NaN, "h:mm AP"), "")

for (const [format, start, end] of [["h:mm AP", "3:00 PM", "4:30 PM"], ["HH:mm", "15:00", "16:30"]]) {
  assert.strictEqual(calendar.timeRangeLabel(at(15), at(16, 30), format), start + "–" + end)
  assert.strictEqual(calendar.timeRangeLabel(at(15), at(16, 30), format, " – "), start + " – " + end)
  assert.strictEqual(calendar.dateTimeLabel(at(15), "d MMM", format), "1 Oct " + start)
  assert.strictEqual(calendar.dateTimeLabel(at(15), "d MMM", format, " · "), "1 Oct · " + start)
  assert.strictEqual(calendar.dateTimeLabel(at(15), "ddd, MMM d", format, " · "), "Thu, Oct 1 · " + start,
    "agenda rows and desktop reminders retain their date prefix")
  assert.strictEqual(calendar.dateTimeLabel(at(15), "ddd", format), "Thu " + start,
    "reminder inbox labels remain compact")
  assert.strictEqual(calendar.dateTimeLabel(at(15), "d MMM", format) + " – "
    + calendar.dateTimeLabel(at(16, 30, 2), "d MMM", format), "1 Oct " + start + " – 2 Oct " + end)
  assert.strictEqual(calendar.dateTimeLabel(at(15), "ddd d MMM", format, ", ") + " – "
    + calendar.dateTimeLabel(at(16, 30, 2), "ddd d MMM", format, ", "), "Thu 1 Oct, " + start + " – Fri 2 Oct, " + end,
    "timed multi-day events in the all-day lane retain both dates")
}
assert.strictEqual(calendar.timeRangeLabel(at(23, 30), at(0, 15, 2), "h:mm AP"), "11:30 PM–12:15 AM")
assert.strictEqual(calendar.timeRangeLabel(at(11, 30), at(12, 15), "h:mm AP"), "11:30 AM–12:15 PM")

console.log("test_calendar_time.js: all assertions passed")
