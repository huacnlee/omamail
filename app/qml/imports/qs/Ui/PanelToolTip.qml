import QtQuick
import QtQuick.Controls as QQC
import qs.Commons

QQC.ToolTip {
  property string fontFamily: Style.font.family
  font.family: fontFamily
  font.pixelSize: Style.font.caption
  palette.window: Color.popups.background
  palette.windowText: Color.foreground
}
