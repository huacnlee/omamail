import QtQuick
import QtQuick.Controls as QQC
import qs.Commons

QQC.ToolTip {
  property string fontFamily: Style.font.family
  delay: Style.tooltipDelay
  font.family: fontFamily
  font.pixelSize: Style.font.caption
  palette.window: Color.popups.background
  palette.windowText: Color.popups.text
}
