import QtQuick
import QtQuick.Templates as T
import qs.Commons

T.ToolTip {
  id: control

  objectName: "omamail-tooltip"
  property real positionedX: 0
  property real positionedY: parent ? parent.height + Style.spacing.xs : 0
  readonly property var anchorWindow: parent ? parent.Window.window : null
  x: positionedX
  y: positionedY
  implicitWidth: Math.max(implicitBackgroundWidth + leftInset + rightInset,
    implicitContentWidth + leftPadding + rightPadding)
  implicitHeight: Math.max(implicitBackgroundHeight + topInset + bottomInset,
    implicitContentHeight + topPadding + bottomPadding)
  margins: Style.spacing.md
  delay: Style.tooltipDelay
  horizontalPadding: Style.spacing.controlPaddingX
  verticalPadding: Style.spacing.controlPaddingY
  closePolicy: T.Popup.CloseOnEscape | T.Popup.CloseOnPressOutsideParent
    | T.Popup.CloseOnReleaseOutsideParent

  function reposition() {
    if (!parent) return
    var anchor = parent.mapToItem(null, 0, 0)
    var availableWidth = anchorWindow ? anchorWindow.width : parent.width
    var availableHeight = anchorWindow ? anchorWindow.height : parent.height
    var sceneX = anchor.x + (parent.width - width) / 2
    sceneX = Math.max(0, Math.min(sceneX, Math.max(0, availableWidth - width)))

    var gap = Style.spacing.xs
    var sceneY = anchor.y + parent.height + gap
    if (sceneY + height > availableHeight) sceneY = anchor.y - height - gap
    sceneY = Math.max(0, Math.min(sceneY, Math.max(0, availableHeight - height)))
    positionedX = sceneX - anchor.x
    positionedY = sceneY - anchor.y
  }

  onOpened: Qt.callLater(reposition)
  onWidthChanged: if (opened) Qt.callLater(reposition)
  onHeightChanged: if (opened) Qt.callLater(reposition)

  contentItem: Text {
    objectName: "omamail-tooltip-label"
    text: control.text
    color: Color.popups.text
    font.family: Style.font.family
    font.pixelSize: Style.font.caption
  }

  background: Rectangle {
    objectName: "omamail-tooltip-background"
    color: Color.popups.background
    radius: Style.cornerRadius
    border.width: Style.normalBorderWidth
    border.color: Color.popups.border
  }
}
