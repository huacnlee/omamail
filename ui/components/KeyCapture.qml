import QtQuick
import qs.Commons

// The overlay that records one key for the Keyboard settings section.
//
// A window Shortcut beats a focused item's Keys handler, so the settings row
// cannot read the press itself: Ctrl+, would reopen Settings instead of being
// captured. This takes the focus for as long as a key is being recorded, and
// the router stands its Shortcuts down (`suspended`) while it is up.
//
// It knows nothing about bindings — it reports a press and a cancel, and the
// window decides what either means.
Item {
  id: root

  required property color textColor
  required property color backgroundColor
  required property string panelFontFamily

  // What is being recorded, named on screen.
  property string label: ""
  property bool active: false

  // A key that is not Escape. Modifiers and text come along because
  // keys/Capture.js needs all three to name the sequence.
  signal captured(int key, int modifiers, string text)
  // Escape, a click outside, or the overlay being taken away with a capture
  // still open. The handler is expected to be idempotent: ending a capture is
  // what makes this invisible, which reports the cancel a second time.
  signal cancelled()

  visible: active
  focus: visible
  onVisibleChanged: {
    if (visible) forceActiveFocus()
    else root.cancelled()
  }

  Keys.onPressed: function(event) {
    event.accepted = true
    if (event.isAutoRepeat) return
    if (event.key === Qt.Key_Escape) {
      root.cancelled()
      return
    }
    root.captured(event.key, event.modifiers, event.text)
  }

  Rectangle {
    anchors.fill: parent
    color: Qt.rgba(root.backgroundColor.r, root.backgroundColor.g,
      root.backgroundColor.b, 0.72)

    MouseArea {
      anchors.fill: parent
      onClicked: root.cancelled()
    }

    Text {
      anchors.centerIn: parent
      width: parent.width * 0.7
      horizontalAlignment: Text.AlignHCenter
      text: "Press a key for " + root.label + "\nEsc cancels"
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.subtitle
      wrapMode: Text.WordWrap
      textFormat: Text.PlainText
    }
  }
}
