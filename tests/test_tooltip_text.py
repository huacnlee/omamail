"""Actual standalone tooltip renders untrusted titles without resource requests."""
import json
import os
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
requests = []


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        requests.append(self.path)
        self.send_response(404)
        self.end_headers()


QML = r'''
import QtQuick
import QtQuick.Controls
import QtTest
import @STYLE@ as AppStyle
import @COMPONENTS@ as Mail
import @CALENDAR@ as Calendar
Item {
  id: host
  width: 500; height: 400
  property string endpoint: @ENDPOINT@
  Component { id: activationSpyFactory; SignalSpy { signalName: "eventActivated" } }
  Component { id: controlFactory; Text { textFormat: Text.AutoText } }
  Component {
    id: controllerFactory
    QtObject {
      property var events: []
      function colorKeyFor(source) { return "accent" }
    }
  }
  Component { id: tipFactory; AppStyle.ToolTip {} }
  Component {
    id: weekFactory
    Mail.WeekCalendarView {
      width: 500; height: 400
      days: Calendar.weekDays(new Date(2026, 9, 25, 12).getTime(), 1)
      nowMs: 0; textColor: "#eeeeee"; backgroundColor: "#222222"
      accentColor: "#5599ff"; urgentColor: "#ff5555"; dimColor: "#999999"
      calendarBorderColor: "#555555"; calendarTodayBackgroundColor: "#333333"
      calendarBorderWidth: 1; panelFontFamily: "monospace"; selectedEventId: ""
    }
  }
  TestCase {
    name: "TooltipPlainText"
    when: windowShown
    function test_1_control() {
      var item = createTemporaryObject(controlFactory, host, {text: '<img src="' + endpoint + '/control">'})
      verify(item !== null)
      wait(300)
    }
    function blocks(item, out) {
      if (item.eventData !== undefined && item.laneWidth !== undefined) out.push(item)
      var children = item.children || []
      for (var i = 0; i < children.length; i++) blocks(children[i], out)
      return out
    }
    function test_3_calendar_dense_and_hover() {
      var events = []
      var start = new Date(2026, 9, 25, 9).getTime()
      for (var i = 0; i < 30; i++) events.push({uid: "event-" + i,
        summary: '<img src="' + endpoint + '/calendar-' + i + '">',
        start: {ms: start}, end: {ms: start + 3600000}})
      var controller = createTemporaryObject(controllerFactory, host)
      controller.events = events
      var view = createTemporaryObject(weekFactory, host, {controller: controller})
      verify(view !== null)
      wait(100)
      var drawn = blocks(view, [])
      compare(drawn.length, 30)
      drawn.sort(function(a, b) { return a.x - b.x })
      for (var j = 0; j < drawn.length; j++) {
        var block = drawn[j]
        verify(block.x >= 0)
        verify(block.x + block.width <= block.parent.width + 0.001)
        if (j > 0) verify(drawn[j - 1].x + drawn[j - 1].width <= block.x + 0.001)
      }
      // The center of a narrow block exercises the actual hover binding.
      mouseMove(drawn[0], drawn[0].width / 2, 10)
      wait(600)
      var tip = findChild(drawn[0], "calendar-event-tooltip")
      verify(tip !== null)
      verify(tip.visible, "hover opens the production calendar tooltip")
      verify(tip.contentItem.text.indexOf(events[0].summary) === 0)
      compare(tip.contentItem.textFormat, Text.PlainText)
      var spy = createTemporaryObject(activationSpyFactory, host, {target: view})
      mouseClick(drawn[0], drawn[0].width / 2, 10)
      compare(spy.count, 1)
    }
    function test_4_repeated_hour() {
      var day = {startMs: new Date('2026-10-25T00:00:00+02:00').getTime(),
        endMs: new Date('2026-10-26T00:00:00+01:00').getTime()}
      var events = ['+02:00', '+01:00'].map(function(offset) {
        return {start: {ms: new Date('2026-10-25T02:10:00' + offset).getTime()},
          end: {ms: new Date('2026-10-25T02:40:00' + offset).getTime()}}
      })
      compare(Calendar.eventTop(events[0], day, 0, 60), Calendar.eventTop(events[1], day, 0, 60))
      var lanes = Calendar.dayLanes(events, day)
      compare(lanes[0].lanes, 2)
      verify(lanes[0].lane !== lanes[1].lane)
    }
    function test_2_titles() {
      var suffixes = ["", "\n", "\r", "\r\n", "\u0000"]
      for (var i = 0; i < suffixes.length; i++) {
        var title = '<img src="' + endpoint + '/forbidden-' + i + '">' + suffixes[i]
        var tip = createTemporaryObject(tipFactory, host, {text: title})
        verify(tip !== null)
        tip.open()
        wait(100)
        compare(tip.contentItem.text, title)
        compare(tip.contentItem.textFormat, Text.PlainText)
        tip.close()
      }
      var tip = createTemporaryObject(tipFactory, host, {text: '中文 "quotes" \\ slash\nline & <b>literal</b>'})
      tip.open()
      compare(tip.contentItem.text, tip.text)
      compare(tip.contentItem.textFormat, Text.PlainText)
      wait(300)
    }
  }
}
'''



def main():
    runner = sys.argv[1] if len(sys.argv) > 1 else "/usr/lib/qt6/bin/qmltestrunner"
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix="omamail-tooltip-text-") as directory:
            imports = Path(directory) / "imports"
            shutil.copytree(ROOT / "ui/tests/qml/imports/Quickshell", imports / "Quickshell")
            shutil.copytree(ROOT / "ui/tests/qml/imports/qs", imports / "qs", dirs_exist_ok=True)
            color = imports / "qs/Commons/Color.qml"
            color.write_text(color.read_text().replace("QtObject {", 'QtObject {\n  readonly property var popups: ({text: "#eeeeee", background: "#222222", border: "#555555"})', 1))
            style = imports / "qs/Commons/Style.qml"
            style.write_text(style.read_text().replace("QtObject {", "QtObject {\n  readonly property int tooltipDelay: 400", 1))
            source = QML.replace("@STYLE@", json.dumps((ROOT / "app/qml/styles/Omamail").as_uri()))
            for key, path in {
                "CALENDAR": "calendar/Calendar.js", "COMPONENTS": "components",
            }.items():
                source = source.replace("@" + key + "@", json.dumps((ROOT / "ui" / path).as_uri()))
            source = source.replace("@ENDPOINT@", json.dumps(f"http://127.0.0.1:{server.server_port}"))
            fixture = Path(directory) / "tst_tooltip_text.qml"
            fixture.write_text(source)
            env = dict(os.environ, TZ="Europe/Berlin", QT_QPA_PLATFORM="offscreen", QT_QUICK_BACKEND="software",
                       QT_QPA_PLATFORMTHEME="", NO_PROXY="127.0.0.1,localhost", no_proxy="127.0.0.1,localhost")
            result = subprocess.run([runner, "-import", str(imports),
                                     "-input", str(fixture)], env=env, timeout=30)
        assert requests == ["/control"], f"Unexpected title network requests: {requests}"
        result.check_returncode()
        print("Tooltip text: native image control observed; no title initiated a request")
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
