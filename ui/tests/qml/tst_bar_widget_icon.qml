import QtQuick 2.15
import QtTest 1.3
import "../.." as Omamail
import "../../bar/Bridge.js" as BarBridge

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
    property string contentDirection: "Auto"
    property int refreshCount: 0
    property int calendarRefreshCount: 0

    // What the widget pushed across, and how many times.
    property var appliedSettings: null
    property int applyCount: 0

    function applySettings(values) {
      appliedSettings = values
      applyCount += 1
    }

    function refresh() { refreshCount += 1 }
    function refreshCalendarPreview() { calendarRefreshCount += 1 }
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
    property string lastPayload: ""
    function serviceFor(_id) { return null }
    function summon(_id, payload) { lastPayload = payload }
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
      BarBridge.clear(BarBridge.current())
      if (typeof widget.syncBridge === "function") widget.syncBridge()
      fakeBar.shell = fakeShell
      fakeService.ready = true
      fakeService.windowOpen = false
      fakeService.showBarIcon = true
      fakeService.applyCount = 0
      fakeService.refreshCount = 0
      fakeService.calendarRefreshCount = 0
      widget.previewOpen = false
    }

    function cleanup() {
      BarBridge.clear(BarBridge.current())
      if (typeof widget.syncBridge === "function") widget.syncBridge()
    }

    function publishPreview() {
      return BarBridge.publish(function() { return fakeService },
        function(values) { fakeService.applySettings(values) },
        function() { fakeService.refresh() },
        function() { fakeService.refreshCalendarPreview() })
    }

    function button() {
      for (var i = 0; i < widget.children.length; i++)
        if (widget.children[i].iconComponent) return widget.children[i]
      fail("bar button was not instantiated")
    }

    function test_replacement_bar_restores_status_settings_and_actions() {
      fakeBar.shell = startingShell
      var api = publishPreview()
      tryVerify(function() { return widget.gmail !== null && widget.gmail.ready }, 2000,
        "a connected mailbox must remain connected inside a restricted replacement bar")
      tryCompare(widget, "bridgeApi", api, 2000)
      verify(widget.gmail !== null)
      verify(widget.gmail !== fakeService, "the full service must stay private")
      compare(widget.gmail.ready, true)
      compare(widget.gmail.unreadTotal, 3)
      verify(fakeService.applyCount > 0, "settings reach the service through the bridge")

      var icon = button().iconComponent.createObject(widget)
      verify(icon !== null)
      compare(icon.children[0].crossed, false)
      compare(icon.children[0].dot, true)
      fakeService.ready = false
      fakeService.windowOpen = true
      widget.syncBridge()
      compare(icon.children[0].crossed, true, "real disconnects still show a slash")
      compare(button().windowOpen, true)
      icon.destroy()

      button().pressed(Qt.MiddleButton)
      compare(fakeService.refreshCount, 1)
      button().pressed(Qt.RightButton)
      compare(widget.previewOpen, true)
      compare(fakeService.calendarRefreshCount, 1)
      widget.openMessage("ada@example.org", "mail-1")
      compare(JSON.parse(startingShell.lastPayload).messageId, "mail-1")

      fakeService.showBarIcon = false
      widget.syncBridge()
      compare(widget.drawsIcon, false)
      compare(widget.implicitWidth, 0)
      fakeService.applyCount = 0
      var replacement = publishPreview()
      BarBridge.clear(api)
      widget.syncBridge()
      verify(fakeService.applyCount > 0, "hot reload reapplies the widget settings")
      compare(widget.bridgeApi, replacement)
      BarBridge.clear(replacement)
      BarBridge.clear(api)
      widget.syncBridge()
      compare(widget.gmail, null, "no stale session survives service shutdown")
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
