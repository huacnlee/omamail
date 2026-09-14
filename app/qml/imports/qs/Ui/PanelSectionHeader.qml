import QtQuick
import qs.Commons

Text {
  property color foreground: Color.foreground
  property string fontFamily: Style.font.family
  color: foreground
  font.family: fontFamily
  font.pixelSize: Style.font.subtitle
  font.bold: true
}
