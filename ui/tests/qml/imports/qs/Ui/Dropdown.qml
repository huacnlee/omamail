import QtQuick
import QtQuick.Controls as Controls
import qs.Commons

// A stand-in for the shell's dropdown. The kit's Dropdown keeps the shell's
// control for Follow Omarchy, so the stub has to select a row the way the shell
// does: it assigns its own `value` when a row is chosen, which severs whatever
// binding the caller had, and it reports the choice through `changed`.
Item {
  id: root

  property string label: ""
  property string value: ""
  property var options: []
  property color foreground: Commons.Color.popups.text
  property color background: Commons.Color.popups.background
  property color popupBorder: Commons.Color.popups.border
  property color accent: Commons.Color.accent
  property string fontFamily: "monospace"
  property int rowHeight: 36
  property int popupRowHeight: 28
  property bool showLabel: true
  property bool hasCursor: false

  readonly property bool popupOpen: popup.opened
  readonly property int currentIndex: indexOf(root.value)

  signal changed(string value)
  signal hovered(bool isHovered)

  implicitWidth: 240
  implicitHeight: rowHeight

  function indexOf(choice) {
    for (var i = 0; i < root.options.length; i++)
      if (String(root.options[i].value) === String(choice)) return i
    return 0
  }
  function currentLabel() {
    return String(root.options[root.indexOf(root.value)].label)
  }
  function open() { popup.open() }
  function close() { popup.close() }
  function choose(index) {
    if (index < 0 || index >= root.options.length) return
    var next = String(root.options[index].value)
    root.value = next
    root.changed(next)
  }

  Rectangle {
    anchors.fill: parent
    color: root.background
    Text {
      anchors.left: parent.left
      anchors.leftMargin: 8
      anchors.verticalCenter: parent.verticalCenter
      text: root.showLabel ? String(root.options[root.indexOf(root.value)].label) : ""
      color: root.foreground
      font.family: root.fontFamily
    }
  }

  TapHandler { onTapped: root.open() }

  Controls.Popup {
    id: popup
    parent: Controls.Overlay.overlay
    x: 0
    y: 0
    width: root.width
    height: Math.min(root.options.length * root.popupRowHeight, 320)
    modal: true
    focus: true
    property int cursor: 0

    onOpened: { cursor = root.currentIndex; list.forceActiveFocus() }

    background: Rectangle {
      color: root.background
      border.width: 1
      border.color: root.popupBorder
    }

    ListView {
      id: list
      anchors.fill: parent
      focus: true
      model: root.options
      Keys.onDownPressed: popup.cursor = Math.min(popup.cursor + 1, root.options.length - 1)
      Keys.onUpPressed: popup.cursor = Math.max(popup.cursor - 1, 0)
      Keys.onReturnPressed: { root.choose(popup.cursor); popup.close() }
      Keys.onEnterPressed: { root.choose(popup.cursor); popup.close() }
      Keys.onEscapePressed: popup.close()
      delegate: Item {
        height: root.popupRowHeight
        width: ListView.view.width
        Text {
          anchors.left: parent.left
          anchors.leftMargin: 8
          anchors.verticalCenter: parent.verticalCenter
          text: modelData.label
          color: root.foreground
          font.family: root.fontFamily
        }
      }
    }
  }
}
