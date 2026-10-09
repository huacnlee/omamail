import QtQuick
import QtQuick.Templates as T
import qs.Commons
import qs.Commons as Commons

T.ScrollBar {
  id: control

  implicitWidth: Math.max(implicitBackgroundWidth + leftInset + rightInset,
    implicitContentWidth + leftPadding + rightPadding)
  implicitHeight: Math.max(implicitBackgroundHeight + topInset + bottomInset,
    implicitContentHeight + topPadding + bottomPadding)

  padding: Style.space(2)
  visible: policy !== T.ScrollBar.AlwaysOff
  minimumSize: orientation === Qt.Horizontal ? height / width : width / height

  contentItem: Rectangle {
    implicitWidth: control.interactive ? Style.space(8) : Style.space(3)
    implicitHeight: control.interactive ? Style.space(8) : Style.space(3)
    radius: Style.cornerRadius
    color: control.pressed
      ? Style.pressedFillFor(Commons.Color.foreground, Commons.Color.accent)
      : (control.hovered
        ? Style.selectedFillFor(Commons.Color.foreground, Commons.Color.accent)
        : Style.hoverFillFor(Commons.Color.foreground, Commons.Color.accent))
    opacity: control.policy === T.ScrollBar.AlwaysOn
      || (control.active && control.size < 1.0) ? 1 : 0

    Behavior on opacity { NumberAnimation { duration: 140 } }
  }

  background: Rectangle {
    visible: control.policy === T.ScrollBar.AlwaysOn
      || (control.active && control.size < 1.0)
    radius: Style.cornerRadius
    color: Style.normalFillFor(Commons.Color.foreground, Commons.Color.accent)
  }
}
