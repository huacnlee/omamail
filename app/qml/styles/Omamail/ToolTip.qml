import QtQuick
import QtQuick.Templates as T
import qs.Commons

T.ToolTip {
  id: control

  objectName: "omamail-tooltip"
  delay: Style.tooltipDelay
  padding: 0

  contentItem: Text {
    objectName: "omamail-tooltip-label"
    text: control.text
    color: Color.popups.text
    font.family: Style.font.family
    font.pixelSize: Style.font.caption
    leftPadding: Style.spacing.controlPaddingX
    rightPadding: Style.spacing.controlPaddingX
    topPadding: Style.spacing.controlPaddingY
    bottomPadding: Style.spacing.controlPaddingY
  }

  background: Rectangle {
    objectName: "omamail-tooltip-background"
    color: Color.popups.background
    radius: Style.cornerRadius
    border.width: Style.normalBorderWidth
    border.color: Color.popups.border
  }
}
