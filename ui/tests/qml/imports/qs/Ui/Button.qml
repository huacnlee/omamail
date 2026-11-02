import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Commons as Commons

// A stand-in for the shell's button. It keeps the public surface the kit's
// Button reaches for — including the tooltip palette and `borderSpec`, which
// the real control publishes and paints — because a property the real
// component has and this one does not is a component that will not
// instantiate here and does instantiate in the shell.
Rectangle {
  id: root

  property string text: ""
  property string iconText: ""
  property string tooltipText: ""

  property bool selected: false
  property bool active: false
  property bool hasCursor: false
  property bool focusable: false
  property bool bordered: false

  property color foreground: Commons.Color.foreground
  property color background: "transparent"
  property color accent: Commons.Color.accent

  property color tooltipBackground: Commons.Color.tooltip.background
  property color tooltipForeground: Commons.Color.tooltip.text
  property color tooltipBorder: Commons.Color.tooltip.border

  // The shell draws its border from a spec; the stub keeps the same shape so a
  // caller that replaces the spec is drawn with, not just accepted.
  property var borderSpec: Commons.Border.controlSpec(
    root.selected ? "selected" : (root.bordered ? "normal" : "none"), foreground, accent)

  property string fontFamily: "monospace"
  property real fontSize: 13
  property real horizontalPadding: 8
  property real verticalPadding: 5
  property bool leftAlign: false

  readonly property bool hot: hasCursor || mouseArea.containsMouse

  signal clicked()
  signal hovered(bool isHovered)

  color: background
  // The shell's surface is Rectangle-compatible and drives its own `border`
  // from the spec, so callers read `border.color` there.
  border.width: root.borderSpec && root.borderSpec.widths ? root.borderSpec.widths.top : 0
  border.color: root.borderSpec ? root.borderSpec.color : "transparent"
  activeFocusOnTab: focusable
  Keys.onReturnPressed: if (focusable) clicked()
  Keys.onEnterPressed: if (focusable) clicked()
  Keys.onSpacePressed: if (focusable) clicked()

  implicitWidth: Math.max(40, label.implicitWidth + horizontalPadding * 2)
  implicitHeight: label.implicitHeight + verticalPadding * 2

  Text {
    id: label
    anchors.centerIn: parent
    text: parent.text
    color: parent.foreground
    font.family: parent.fontFamily
    font.pixelSize: parent.fontSize
    font.bold: parent.selected
  }

  MouseArea {
    id: mouseArea
    anchors.fill: parent
    hoverEnabled: true
    onContainsMouseChanged: root.hovered(containsMouse)
    onClicked: root.clicked()
  }

  ToolTip {
    id: tip
    objectName: "button-tooltip"
    visible: root.tooltipText !== "" && mouseArea.containsMouse
    text: root.tooltipText
    background: Rectangle {
      color: root.tooltipBackground
      border.width: 1
      border.color: root.tooltipBorder
    }
    contentItem: Text {
      text: tip.text
      color: root.tooltipForeground
      font.family: root.fontFamily
      font.pixelSize: root.fontSize
    }
  }
}
