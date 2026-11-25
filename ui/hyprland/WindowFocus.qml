import QtQuick
import Quickshell.Hyprland

// Brings the mail window in front of the person who clicked a notification.
//
// The window keeps the workspace it was left on, so a message opened from a
// notification could load on another workspace and look as if nothing had
// happened. Focusing the window by its exact title makes Hyprland switch to
// it. The request is repeated for up to about 1.5 s because a window the
// click has just summoned may not be mapped yet, and stops once Hyprland
// reports the window as active.
//
// Hyprland-only, behind a Loader in App.qml, so the standalone host and the
// QML tests never load it.
Item {
  id: root
  visible: false

  property string windowTitle: ""
  property int maxAttempts: 12
  property int attempts: 0

  function bringToFront() {
    if (windowTitle === "") return
    attempts = 0
    retry.restart()
    focusOnce()
  }

  function escapeRegex(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }

  function focusOnce() {
    attempts = attempts + 1
    // Long brackets: the config is Lua and the title is a regular expression,
    // so its backslashes have to survive both.
    Hyprland.dispatch("hl.dsp.focus({ window = [[title:^"
      + escapeRegex(windowTitle) + "$]] })")
  }

  Timer {
    id: retry
    interval: 120
    repeat: true
    onTriggered: {
      var active = Hyprland.activeToplevel
      if ((active && String(active.title || "") === root.windowTitle) || root.attempts >= root.maxAttempts) {
        stop()
        return
      }
      root.focusOnce()
    }
  }
}
