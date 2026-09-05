import QtQuick 2.15
import QtTest 1.3
import "../.." as Omamail

// The bar widget with its icon turned off.
//
// It has to stay in the bar to keep working: it is the only thing that hands
// plugin settings to the service, so a widget removed from the layout instead
// of hidden here would leave the service running on the manifest's defaults.
// That is the whole reason this is a setting rather than a line deleted from
// shell.json, and it is what these assert.
Item {
  width: 400
  height: 60

  QtObject {
    id: fakeService

    property bool showBarIcon: true
    property bool ready: true
    property bool windowOpen: false
    property int unreadTotal: 3
    property string barTooltip: "Omamail"
    property var barMessages: []
    property var barEvents: []

    // What the widget pushed across, and how many times.
    property var appliedSettings: null
    property int applyCount: 0

    function applySettings(values) {
      appliedSettings = values
      applyCount += 1
    }

    function refreshCalendarPreview() {}
  }

  QtObject {
    id: fakeShell
    function serviceFor(_id) { return fakeService }
    function summon(_id, _payload) {}
  }

  // The shell before it has built the service. `Shell.serviceFor` is a lookup
  // in a map the shell fills in as it constructs services — it never creates
  // one — so a bar widget really can be asked to draw with nothing to ask.
  QtObject {
    id: startingShell
    function serviceFor(_id) { return null }
    function summon(_id, _payload) {}
  }

  QtObject {
    id: fakeBar
    property var shell: fakeShell
    property bool vertical: false
    property color barForeground: Qt.rgba(1, 1, 1, 1)
  }

  Omamail.BarWidget {
    id: widget
    bar: fakeBar
    settings: ({ refreshIntervalSec: 300, showBarIcon: true })
  }

  TestCase {
    name: "BarWidgetIcon"
    when: windowShown

    function init() {
      fakeBar.shell = fakeShell
      fakeService.showBarIcon = true
      fakeService.applyCount = 0
    }

    function test_the_icon_is_drawn_by_default() {
      compare(widget.drawsIcon, true)
      compare(widget.visible, true)
      verify(widget.implicitWidth > 0)
    }

    // Not merely invisible: it gives up its width too, so the bar closes over
    // the gap rather than leaving a hole where the envelope was.
    function test_turning_it_off_takes_the_width_with_it() {
      fakeService.showBarIcon = false
      compare(widget.drawsIcon, false)
      compare(widget.visible, false)
      compare(widget.implicitWidth, 0)
      compare(widget.implicitHeight, 0)
    }

    // The point of hiding rather than removing: settings still reach the
    // service, so the refresh interval and the rest survive.
    function test_a_hidden_widget_still_hands_settings_to_the_service() {
      fakeService.showBarIcon = false
      fakeService.applyCount = 0

      widget.settings = ({ refreshIntervalSec: 600, showBarIcon: false })

      compare(fakeService.applyCount, 1,
        "a hidden widget is still the only route settings have")
      compare(fakeService.appliedSettings.refreshIntervalSec, 600)
      compare(widget.drawsIcon, false, "and it is still hidden")
    }

    // With no service to ask, the icon is drawn: a widget that vanished while
    // the service was starting would flicker out of the bar on every login.
    //
    // The shell is swapped for one holding no service, because a fake that
    // always answers with one leaves this branch unmeasured: `drawsIcon` is
    // true there whether the missing service means "draw" or "do not".
    function test_no_service_yet_still_draws() {
      fakeBar.shell = startingShell
      compare(widget.gmail, null, "the shell has no service to hand over yet")
      compare(widget.drawsIcon, true)
      compare(widget.visible, true)
      verify(widget.implicitWidth > 0)
    }
  }
}
