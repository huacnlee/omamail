import QtQuick
import Quickshell
import Quickshell.Hyprland
import Quickshell.Wayland

Item {
  id: root

  property var app: null
  readonly property alias mount: mailContent
  property real progress: 0

  function beginClose() {
    if (!overlay.contentRevealed || progress <= 0) return false
    app.dropDownClosing = true
    animateTo(0)
    return true
  }

  function animateTo(destination) {
    animation.stop()
    animation.to = destination
    animation.duration = destination === 1 ? 260 : 180
    animation.start()
  }

  Connections {
    target: root.app
    function onDropDownClosingChanged() {
      if (overlay.interactive && overlay.contentRevealed)
        root.animateTo(1)
    }
  }

  NumberAnimation {
    id: animation
    target: root
    property: "progress"
    easing.type: to === 1 ? Easing.OutCubic : Easing.InCubic
    onFinished: {
      if (to === 0 && root.app && root.app.dropDownClosing) root.app.finishClose()
    }
  }

  function focusedScreen() {
    var monitor = Hyprland.focusedMonitor
    for (var i = 0; monitor && i < Quickshell.screens.length; i++) {
      if (Quickshell.screens[i].name === monitor.name) return Quickshell.screens[i]
    }
    return Quickshell.screens.length > 0 ? Quickshell.screens[0] : null
  }

  PanelWindow {
    id: overlay

    readonly property bool shown: !!root.app && root.app.opened
    readonly property bool interactive: shown && !root.app.dropDownClosing
    property var targetScreen: null
    readonly property bool contentRevealed: backingWindowVisible && !!targetScreen
      && width > 0 && height > 0

    visible: shown && !!targetScreen
    screen: targetScreen
    anchors { top: true; left: true; bottom: true; right: true }
    color: "transparent"
    // Let the compositor reserve the bar's space, including on other edges.
    exclusionMode: ExclusionMode.Normal
    exclusiveZone: 0
    margins { top: 10; right: 10; bottom: 10; left: 10 }
    WlrLayershell.layer: WlrLayer.Overlay
    // Hyprland focuses an OnDemand layer when it maps. Keep that mode
    // throughout the slide so the bar can still receive pointer input.
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.OnDemand
    WlrLayershell.namespace: "omamail-drop-down"

    onShownChanged: targetScreen = shown ? root.focusedScreen() : null
    onContentRevealedChanged: {
      if (contentRevealed && !root.app.dropDownClosing) {
        root.animateTo(1)
        Qt.callLater(root.app.focusMail)
      } else if (!shown) {
        animation.stop()
        root.progress = 0
      }
    }

    Connections {
      target: Quickshell
      function onScreensChanged() {
        if (!overlay.shown || Quickshell.screens.indexOf(overlay.targetScreen) >= 0) return
        overlay.targetScreen = null
        // Qt is still tearing down the surface on the removed output.
        Qt.callLater(function() {
          if (overlay.shown && !overlay.targetScreen)
            overlay.targetScreen = root.focusedScreen()
        })
      }
    }

    FocusScope {
      id: slide
      width: parent.width
      height: parent.height
      y: (root.progress - 1) * height
      focus: true

      Rectangle {
        id: frame
        anchors.fill: parent
        color: root.app ? root.app.background : "transparent"
        border.color: root.app ? root.app.borderColor : "transparent"
        border.width: root.app ? root.app.borderWidth : 0

        Item {
          id: mailContent
          anchors.fill: parent
          anchors.margins: frame.border.width
        }
      }

      Shortcut {
        sequence: "Escape"
        enabled: !!root.app && root.app.backendUnavailable
        onActivated: root.app.requestClose()
      }
    }
  }
}
