import QtQuick 2.15
import QtTest 1.3
import "../.." as Omamail
import "../../bar/Bridge.js" as BarBridge

Item {
  width: 400
  height: 60

  QtObject {
    id: restrictedShell
    function serviceFor(_id) { return null }
    function summon(_id, _payload) {}
  }
  QtObject {
    id: bar
    property var shell: restrictedShell
    property bool vertical: false
    property color barForeground: Qt.rgba(1, 1, 1, 1)
  }
  Omamail.BarWidget {
    id: widget
    bar: bar
    settings: ({ refreshIntervalSec: 300, showBarIcon: true })
  }
  Component { id: serviceFactory; Omamail.Service {} }

  TestCase {
    name: "BarBridgeService"
    when: windowShown

    function test_real_service_publishes_and_retires_its_bar_interface() {
      var service = serviceFactory.createObject(null)
      verify(service !== null)
      var api = service.barBridge
      compare(BarBridge.current(), api)
      widget.syncBridge()
      compare(widget.directService, null)
      verify(widget.gmail !== null)
      verify(widget.gmail !== service)
      compare(service.settings.refreshIntervalSec, 300)
      service.unreadTotal = 9
      service.windowOpen = true
      widget.syncBridge()
      compare(widget.gmail.unreadTotal, 9)
      compare(widget.gmail.windowOpen, true)
      compare(widget.gmail.auth, undefined)
      compare(widget.gmail.current, undefined)
      compare(widget.gmail.shell, undefined)

      var replacement = serviceFactory.createObject(null)
      verify(replacement !== null)
      var next = replacement.barBridge
      verify(next !== api)
      widget.syncBridge()
      compare(replacement.settings.refreshIntervalSec, 300)
      service.destroy()
      wait(0)
      compare(BarBridge.current(), next)
      compare(api.snapshot(), null)
      replacement.destroy()
      wait(0)
      compare(BarBridge.current(), null)
      widget.syncBridge()
      compare(widget.gmail, null)
    }
  }
}
