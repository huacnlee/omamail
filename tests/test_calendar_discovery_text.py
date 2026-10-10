"""A discovered CalDAV calendar's name stays text, without image requests.

The name is the collection's displayname: whoever runs the server, or shared
the calendar, chose it. The checklist that offers discovered calendars is the
real CalendarSettings with shell styling stubs; Qt's Text and image loader are
real. A positive control proves the loopback observer sees a native image
request, so a silent observer is not mistaken for a plain Text.
"""
import json
import os
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
import QtTest
import @COMPONENTS@ as Mail

Item {
  id: host
  width: 600; height: 800
  property string endpoint: @ENDPOINT@
  QtObject {
    id: mailService
    property var accountSummaries: []
    property bool backendCanDiscoverCalendars: true
    property bool backendCanGoogleCalendars: true
    property bool unifiedCalendarView: false
    property bool calendarRemindersEnabled: true
    property int calendarSnoozeMinutes: 5
    property string calendarReminderError: ""
    property string calendarPalettePath: ""
  }
  QtObject {
    id: calendarController
    property var sourceList: ({ version: 1, sources: [] })
    property var availableSources: sourceList
    property bool savingSource: false
    property bool discoveringCalendars: false
    property string discoveringAccountId: ""
    property var discoveryChoices: null
    property string discoveryChoiceAccount: ""
    property bool caldavServerDiscovering: false
    property var caldavServerDiscoveryResults: []
    property bool caldavAdding: false
    signal calendarSaved(bool ok, string error)
    signal discoveryFinished(bool ok, string error, int count)
    signal caldavServerDiscoveryFinished(bool ok, string error)
    signal caldavCalendarsAdded(bool ok, string error, int added, int total)
    function canDiscoverCaldavServer() { return true }
    function cancelCaldavServerDiscovery() { caldavServerDiscoveryResults = [] }
  }
  Mail.CalendarSettings {
    id: settings
    width: 600
    service: mailService
    controller: calendarController
    textColor: "black"; accentColor: "blue"; dimColor: "gray"; urgentColor: "red"
    panelFontFamily: "monospace"
  }
  Component { id: controlFactory; Text { textFormat: Text.AutoText } }
  TestCase {
    name: "CalendarDiscoveryPlainText"
    when: windowShown
    function named(item, name, out) {
      if (item.objectName === name) out.push(item)
      var children = item.children || []
      for (var i = 0; i < children.length; i++) named(children[i], name, out)
      return out
    }
    function test_1_observer_positive_control() {
      var item = createTemporaryObject(controlFactory, host, {
        text: '<img src="' + endpoint + '/control">'
      })
      verify(item !== null)
      wait(300)
    }
    function test_2_discovered_names() {
      var names = [
        '<img src="' + endpoint + '/name">',
        '<b>Family</b><img src="' + endpoint + '/nested">',
        '<img\nsrc="' + endpoint + '/lf">',
        '<img\r\nsrc="' + endpoint + '/crlf">',
        '<img src="' + endpoint + '/trailing">\n',
        'A & B / 中文 / مرحبا / "quotes" / \\backslash',
        'literal &lt;img&gt; and <b>bold</b>'
      ]
      var open = named(settings, "calendar-caldav-discover", [])
      compare(open.length, 1)
      open[0].clicked()
      calendarController.caldavServerDiscoveryResults = names.map(function(name, index) {
        return { name: name, url: "https://caldav.example/" + index + "/", readOnly: index % 2 === 1 }
      })
      calendarController.caldavServerDiscoveryFinished(true, "")
      wait(50)
      var drawn = named(settings, "calendar-caldav-discovered-name", [])
      compare(drawn.length, names.length)
      for (var i = 0; i < names.length; i++) {
        compare(drawn[i].text, names[i], "The server's name must reach the row unchanged")
        compare(drawn[i].textFormat, Text.PlainText, "A calendar name is never HTML")
        verify(drawn[i].visible)
      }
    }
    function test_3_drain_network() { wait(300) }
  }
}
'''


def main():
    runner = sys.argv[1] if len(sys.argv) > 1 else "/usr/lib/qt6/bin/qmltestrunner"
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix="omamail-calendar-discovery-text-") as directory:
            source = QML.replace("@COMPONENTS@", json.dumps((ROOT / "ui/components").as_uri()))
            source = source.replace("@ENDPOINT@", json.dumps(f"http://127.0.0.1:{server.server_port}"))
            fixture = Path(directory) / "tst_calendar_discovery_text.qml"
            fixture.write_text(source)
            env = dict(os.environ, QT_QPA_PLATFORM="offscreen", QT_QUICK_BACKEND="software",
                       QT_QPA_PLATFORMTHEME="", NO_PROXY="127.0.0.1,localhost", no_proxy="127.0.0.1,localhost")
            result = subprocess.run([runner, "-import", str(ROOT / "ui/tests/qml/imports"),
                                     "-input", str(fixture)], env=env, timeout=30)
        assert requests == ["/control"], f"Unexpected calendar name network requests: {requests}"
        result.check_returncode()
        print("Calendar discovery text: native image control observed; no calendar name initiated a request")
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
