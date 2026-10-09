import QtQuick
import QtQuick.Controls as QQC
import qs.Commons
import qs.Commons as Commons

QQC.ToolTip {
  property string fontFamily: Style.font.family
  delay: Style.tooltipDelay
  font.family: fontFamily
  font.pixelSize: Style.font.caption
  palette.window: Commons.Color.popups.background
  palette.windowText: Commons.Color.popups.text
}
