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
    // A trigger holds a selected style for as long as what it opened is on
    // screen, which is what answers "which of these opened that window". The
    // service is what knows: it outlives the window and is told either way.
    readonly property bool windowOpen: !!root.gmail && root.gmail.windowOpen
    // Not `activeColor`: the bar hands that down from the theme's `bar.active`,
    // which falls back to `urgent` — a warning colour for a window simply being
    // open. The glyph keeps its own colour and the open state is a fill behind
    // it, which is what a selected control looks like everywhere else here.
    readonly property color glyphColor: connected
      ? root.foreground
      : Qt.darker(root.foreground, 1.55)
    readonly property bool hasUnread: !!root.gmail && root.gmail.unreadTotal > 0

    // The bar's own `active` is left alone on purpose: it exists to recolour a
    // glyph, and this widget draws its own.
    readonly property color openFill: Style.selectedFillFor(root.foreground, Color.accent)

    iconComponent: Component {
      Item {
        // The same fill a selected control carries anywhere else in this
        // application, so an open window reads as open rather than as urgent.
        Rectangle {
          anchors.centerIn: parent
          width: Style.space(20)
          height: width
          radius: Style.cornerRadius
          visible: button.windowOpen
          color: button.openFill
        }

        GmailIcon {
          anchors.centerIn: parent
          iconSize: Style.space(12)
          color: button.glyphColor
          // The dot is simply whether unread mail is waiting. It used to mean
          // "something arrived since you last looked", which was a different
          // question from the one anyone asks of a mail icon, and it could not
          // be answered honestly while the count included every categorised
          // message. Now that the count is Primary-scoped it reaches zero, so
          // the dot can just follow it.
          dot: button.hasUnread
          crossed: !button.connected
        }
      }
    }

    onPressed: function(buttonCode) {
      // Right-click does nothing. It used to open the web inbox, which is the
      // one thing this application exists so you do not have to do, and it is
      // also where a context menu is expected — so the gesture was both wrong
      // and reserved. Left opens the window, middle checks for mail.
      if (buttonCode === Qt.RightButton) return
      if (buttonCode === Qt.MiddleButton) {
        if (root.gmail) root.gmail.refresh()
        return
      }
      root.openWindow()
    }
  }
}
