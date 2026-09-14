import QtQuick
import QtQuick.Controls.Basic as QQC
import qs.Commons

QQC.TextField {
  id: root

  property bool password: false
  property color foreground: Color.foreground
  property color accent: Color.accent
  property real verticalPadding: Style.spacing.inputPaddingY
  property real horizontalPadding: Style.spacing.controlPaddingX

  color: foreground
  selectionColor: Style.selectionFillFor(foreground, accent)
  selectedTextColor: foreground
  placeholderTextColor: Style.mutedColorFor(foreground, Color.background)
  echoMode: password ? TextInput.Password : TextInput.Normal
  topPadding: verticalPadding
  bottomPadding: verticalPadding
  leftPadding: horizontalPadding
  rightPadding: horizontalPadding
  font.family: Style.font.family
  font.pixelSize: Style.font.bodySmall

  background: Rectangle {
    color: Style.normalFillFor(root.foreground, root.accent)
    radius: Style.cornerRadius
    border.width: Style.normalBorderWidth
    border.color: root.activeFocus
      ? Style.hoverBorderFor(root.foreground, root.accent)
      : Style.normalBorderFor(root.foreground, root.accent)
  }
}
