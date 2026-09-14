import QtQuick
import QtQuick.Controls.Basic as QQC
import qs.Commons

Item {
  id: root

  property string iconText: ""
  property string tooltipText: ""
  property color foreground: Color.foreground
  property color hoverColor: foreground
  property string fontFamily: Style.font.family
  property real fontSize: Style.font.bodySmall
  property bool focusable: false
  property bool hasCursor: false
  property bool bordered: false
  signal clicked()
  signal hovered(bool isHovered)

  implicitWidth: Math.max(Style.spacing.controlHeight, glyph.implicitWidth + Style.spacing.controlPaddingX * 2)
  implicitHeight: Style.spacing.controlHeight

  Rectangle {
    anchors.fill: parent
    radius: Style.cornerRadius
    color: control.down ? Style.pressedFillFor(root.foreground, root.hoverColor)
      : (root.hasCursor ? Style.selectedFillFor(root.foreground, root.hoverColor)
        : (control.hovered ? Style.hoverFillFor(root.foreground, root.hoverColor)
          : Style.withAlpha(root.foreground, 0)))
    border.width: root.bordered ? Style.normalBorderWidth : 0
    border.color: Style.normalBorderFor(root.foreground, root.hoverColor)
  }

  Text {
    id: glyph
    anchors.centerIn: parent
    text: root.iconText
    color: control.hovered || root.hasCursor ? root.hoverColor : root.foreground
    font.family: root.fontFamily
    font.pixelSize: root.fontSize
  }

  QQC.Button {
    id: control
    anchors.fill: parent
    flat: true
    focusPolicy: root.focusable ? Qt.StrongFocus : Qt.NoFocus
    background: Item {}
    contentItem: Item {}
    onClicked: root.clicked()
    onHoveredChanged: root.hovered(hovered)
  }

  PanelToolTip {
    visible: control.hovered && root.tooltipText !== ""
    text: root.tooltipText
    fontFamily: root.fontFamily
  }
}
