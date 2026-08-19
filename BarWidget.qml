import QtQuick
import qs.Commons
import qs.Ui
import "components"

// The bar's job is one number and one click. Everything the widget knows comes
// from the shared service, which keeps running whether or not the window is
// open — that is the whole reason the unread count can be trusted.
BarWidget {
  id: root

  moduleName: "gmail.omarchy"

  readonly property var gmail: bar && bar.shell
    ? bar.shell.serviceFor("gmail.omarchy") : null

  // The service is a singleton shared with the window, and the shell hands
  // plugin settings to the bar widget rather than to the service, so the
  // widget is what pushes them across.
  function pushSettings() {
    if (gmail && typeof gmail.applySettings === "function") gmail.applySettings(settings)
  }

  onSettingsChanged: pushSettings()
  onGmailChanged: pushSettings()
  Component.onCompleted: pushSettings()

  function openWindow() {
    if (bar && bar.shell && typeof bar.shell.toggle === "function")
      bar.shell.toggle("gmail.omarchy", "{}")
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    tooltipText: root.gmail ? root.gmail.barTooltip : "Gmail"

    // Read from inside `iconComponent`. Both BarIconButton and GmailIcon name
    // their own root object `root`, so nothing inside a Component declared
    // here refers to `root` — it would be ambiguous about which one it meant.
    readonly property bool connected: !!root.gmail && root.gmail.ready
    readonly property color glyphColor: connected
      ? root.barForeground
      : Qt.darker(root.barForeground, 1.55)
    readonly property string countText: root.gmail ? root.gmail.badgeText : ""

    iconComponent: Component {
      Item {
        GmailIcon {
          anchors.centerIn: parent
          iconSize: Style.space(12)
          color: button.glyphColor
          badgeColor: Color.urgent
          badgeTextColor: Color.background
          badgeText: button.countText
          // The flap lifts when there is unread mail: at bar size that reads
          // where a colour change on its own does not.
          open: button.countText !== ""
          crossed: !button.connected
        }
      }
    }

    onPressed: function(buttonCode) {
      if (buttonCode === Qt.MiddleButton) {
        if (root.gmail) root.gmail.refresh()
      } else if (buttonCode === Qt.RightButton) {
        if (root.gmail) root.gmail.openWebInbox()
      } else {
        root.openWindow()
      }
    }
  }
}
