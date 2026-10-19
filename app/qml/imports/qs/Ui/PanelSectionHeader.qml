import QtQuick
import qs.Commons
import qs.Commons as Commons

Text {
  property color foreground: Commons.Color.foreground
  property string fontFamily: Style.font.family
  color: foreground
  font.family: fontFamily
  font.pixelSize: Style.font.subtitle
  font.bold: true
}
