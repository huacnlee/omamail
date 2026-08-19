import QtQuick
import qs.Commons
import qs.Ui
import "components"

// The bar's job is one number and one click. Everything the widget knows comes
// from the shared service, which keeps running whether or not the window is
// open — that is the whole reason the unread count can be trusted.
BarWidget {
  id: root

  moduleName: "omamail"

  readonly property var gmail: bar && bar.shell
    ? bar.shell.serviceFor("omamail") : null

  // `barForeground` belongs to qs.Ui.Panel, not to BarWidget: reading it here
  // yields undefined, and assigning undefined to a colour leaves the icon
  // unpainted. The bar itself is the source.
  readonly property color foreground: bar ? bar.foreground : Color.foreground

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
      bar.shell.toggle("omamail", "{}")
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    tooltipText: root.gmail ? root.gmail.barTooltip : "Omamail"

    // Read from inside `iconComponent`. Both BarIconButton and GmailIcon name
    // their own root object `root`, so nothing inside a Component declared
    // here refers to `root` — it would be ambiguous about which one it meant.
    readonly property bool connected: !!root.gmail && root.gmail.ready
    readonly property color glyphColor: connected
      ? root.foreground
      : Qt.darker(root.foreground, 1.55)
    readonly property bool hasUnread: !!root.gmail && root.gmail.unreadTotal > 0
    readonly property bool hasNew: !!root.gmail && root.gmail.newMailPending

    iconComponent: Component {
      Item {
        GmailIcon {
          anchors.centerIn: parent
          iconSize: Style.space(12)
          color: button.glyphColor
          // A closed envelope, always: at 12 px the lifted flap reads as an
          // open box rather than as mail. The dot carries the state instead —
          // and it means "something arrived since you last looked", not "you
          // have unread mail", so it can actually reach zero.
          dot: button.hasNew
          open: false
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
